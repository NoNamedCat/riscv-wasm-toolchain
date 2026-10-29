#!/usr/bin/env node
// Minimal end-to-end compilation with the WebAssembly RISC-V toolchain.
//
// Pipeline:  cc1 (C -> asm)  ->  riscv-as (asm -> object)
//            ->  riscv-ld (object -> ELF)  ->  riscv-objcopy (ELF -> Intel HEX)
//
// Every stage is a genuine GNU tool (GCC 15 / Binutils 2.44) running as
// WebAssembly, instantiated from the modules built by build-riscv-wasm.sh.
//
// Usage:
//   node examples/minimal-compile.mjs [path/to/public/wasm-toolchain]
//   (defaults to ../public/wasm-toolchain relative to this file)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = process.argv[2] || join(here, "..", "public", "wasm-toolchain");

const MAIN_C = `int main(void) {
    volatile int value = 42;
    value = value + 1;
    while (1) {}
    return 0;
}
`;

const LINKER_SCRIPT = `OUTPUT_ARCH(riscv)
MEMORY {
    FLASH (rxa) : ORIGIN = 0x08000000, LENGTH = 64K
    RAM (rwx)   : ORIGIN = 0x20000000, LENGTH = 20K
}
ENTRY(main)
SECTIONS {
    .text   : { *(.text*) }   > FLASH
    .rodata : { *(.rodata*) } > FLASH
    .data   : { *(.data*) }   > FLASH
    .bss    : { *(.bss*) }    > RAM
}
`;

// The toolchain modules are emscripten builds. They detect Node at runtime
// and read their .wasm from the filesystem, so we hand them a require()
// shim plus the module directory.
const nodeFs = (await import("node:fs")).default;
const nodePath = (await import("node:path")).default;
const nodeCrypto = (await import("node:crypto")).default;
function makeRequire() {
  const mods = { fs: nodeFs, path: nodePath, crypto: nodeCrypto };
  return (name) => {
    const m = name.replace(/^node:/, "");
    if (!mods[m]) throw new Error('unsupported require("' + name + '")');
    return mods[m];
  };
}
function loadFactory(jsBase, exportName) {
  const path = join(WASM_DIR, jsBase);
  const text = readFileSync(path, "utf8").replace(/^#!.*?\n/, "");
  const factory = new Function(
    "require", "__dirname", "__filename",
    text + `\nreturn typeof ${exportName} !== 'undefined' ? ${exportName} : (typeof createModule !== 'undefined' ? createModule : null);`
  );
  return factory(makeRequire(), dirname(path), path);
}
async function makeTool(jsBase, wasmName, exportName) {
  const factory = loadFactory(jsBase, exportName);
  return await factory({
    noInitialRun: true,
    locateFile: (p) => join(WASM_DIR, p.endsWith(".wasm") ? wasmName : p),
  });
}

const MARCH = "rv32imac_zicsr", MABI = "ilp32";

// [1] cc1: translate C to RISC-V assembly
const cc1 = await makeTool("cc1.js", "cc1.wasm", "createCc1");
cc1.FS.writeFile("/main.c", MAIN_C);
try { cc1.callMain(["-march=" + MARCH, "-mabi=" + MABI, "-o", "/main.s", "/main.c"]); } catch {}
const asm = cc1.FS.readFile("/main.s", { encoding: "utf8" });
console.log("[1/4] cc1: main.c -> main.s (" + asm.split("\n").length + " asm lines)");

// [2] riscv-as: assemble to a relocatable object
const as = await makeTool("riscv-as.js", "riscv-as.wasm", "createAs");
as.FS.writeFile("/main.s", asm);
try { as.callMain(["-march=" + MARCH, "-mabi=" + MABI, "-o", "/main.o", "/main.s"]); } catch {}
const obj = as.FS.readFile("/main.o");
console.log("[2/4] riscv-as: main.s -> main.o (" + obj.length + " bytes)");

// [3] riscv-ld: link the object into a bare-metal ELF
const ld = await makeTool("riscv-ld.js", "riscv-ld.wasm", "createLd");
ld.FS.writeFile("/main.o", obj);
ld.FS.writeFile("/script.ld", LINKER_SCRIPT);
try { ld.callMain(["-m", "elf32lriscv", "-T", "/script.ld", "-o", "/main.elf", "/main.o"]); } catch {}
const elf = ld.FS.readFile("/main.elf");
console.log("[3/4] riscv-ld: main.o -> main.elf (" + elf.length + " bytes)");

// [4] riscv-objcopy: emit an Intel HEX for flashing
const oc = await makeTool("riscv-objcopy.js", "riscv-objcopy.wasm", "createObjcopy");
oc.FS.writeFile("/main.elf", elf);
try { oc.callMain(["-O", "ihex", "/main.elf", "/main.hex"]); } catch {}
const hex = oc.FS.readFile("/main.hex", { encoding: "utf8" });
console.log("[4/4] riscv-objcopy: main.elf -> main.hex");

// Validate: ELF magic + ELF32 + e_machine == 0xf3 (EM_RISCV)
const ok = elf[0] === 0x7f && elf[1] === 0x45 && elf[2] === 0x4c && elf[3] === 0x46
  && elf[4] === 1 && (elf[18] | (elf[19] << 8)) === 0xf3;
if (!ok) { console.error("ELF validation failed"); process.exit(1); }
console.log("\nOK: valid RISC-V ELF32 (e_machine = 0xf3)");
console.log("---- Intel HEX ----");
console.log(hex);
