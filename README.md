# RISC-V WebAssembly Toolchain

A self-contained **RISC-V compiler and binutils running entirely in
WebAssembly**. It is a drop-in module: embed it in any browser app or Node
program to compile C/C++ to RISC-V ELF / Intel HEX with no native toolchain
and no install on the host.

It builds **GCC 15.2.0**, **GNU Binutils 2.44** and **newlib 4.5.0** to
WebAssembly with Emscripten, then packages a multilib sysroot
(`libc.a`, `libm.a`, `libgcc.a` per multilib) that the tools operate on.

This is the compiler **module only**. Board/chip SDKs (device headers,
startup, per-chip linker script, device libraries) are supplied by the
consuming application at runtime — see [Extending to a board](#extending-to-a-board).

## What it produces

Five real GNU tools running as WebAssembly, plus the sysroot they operate on:

| Module | Tool | Role |
|--------|------|------|
| `cc1` | GCC C frontend | C → RISC-V assembly |
| `cc1plus` | GCC C++ frontend | C++ → RISC-V assembly |
| `riscv-as` | GNU as | assembly → relocatable object |
| `riscv-ld` | GNU ld | objects → bare-metal ELF |
| `riscv-objcopy` | GNU objcopy | ELF → Intel HEX / bin / etc. |

After a successful build the output lives in `public/wasm-toolchain/`:

```
public/wasm-toolchain/
├── cc1.js            cc1.wasm
├── cc1plus.js        cc1plus.wasm
├── riscv-as.js       riscv-as.wasm
├── riscv-ld.js       riscv-ld.wasm
├── riscv-objcopy.js  riscv-objcopy.wasm
├── manifest.json     list of every sysroot file
└── sysroot/
    ├── include/                       C headers (newlib + compiler)
    ├── lib/<multilib>/<abi>/libc.a libm.a libgcc.a crt0.o ...
    ├── lib/gcc/riscv32-unknown-elf/15.2.0/<multilib>/<abi>/libgcc.a
    └── ldscripts/                     default linker scripts
```

### Supported ISAs

The multilib sysroot carries three RISC-V 32-bit configurations:

| Multilib | `-march` | Extensions | ABI |
|----------|----------|-----------|-----|
| `rv32ec` | `rv32e + c` | I(E), C | `ilp32e` |
| `rv32imac` | `rv32i + m + a + c` | I, M, A, C | `ilp32` |
| `rv32imafc` | `rv32i + m + a + c + f` | I, M, A, C, F | `ilp32f` |

No RV64, no double precision, no vector. Extend `--with-multilib-generator`
in `build-riscv-wasm.sh` to add more.

## Requirements

- **Emscripten** (`emsdk`) — the only runtime dependency of the build.
- `node`, `curl`, `xz`, `tar`, and a native C toolchain (`gcc`, `g++`,
  `make`, `flex`, `bison`, `gawk`) to build the native tool first.
- **Network access at build time** — the script downloads the sources.

Verify your Emscripten install:

```sh
source <emsdk>/emsdk_env.sh
emcc --version
```

## Build

```sh
./build-riscv-wasm.sh
```

This:

1. Downloads the GCC, Binutils, newlib, GMP, MPFR and MPC sources.
2. Builds a native RISC-V cross toolchain (GCC + Binutils + newlib).
3. Installs the multilib sysroot into `public/wasm-toolchain/sysroot/`.
4. Cross-compiles each tool to WebAssembly with Emscripten.
5. Writes `manifest.json`.

A full build takes roughly 20–45 minutes depending on the machine. The
script is idempotent; to rebuild from a clean state, remove the work
directories first:

```sh
rm -rf build public
./build-riscv-wasm.sh
```

> The build is long. Run it detached if your terminal/CI step times out:
>
> ```sh
> setsid bash ./build-riscv-wasm.sh < /dev/null > build.log 2>&1 &
> ```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `BUILD_DIR` | `./build` | Scratch dir for downloads and native builds |
| `DIST_DIR` | `./public/wasm-toolchain` | Where the finished modules are written |
| `JOBS` | `$(nproc)` | Parallel make jobs |
| `GCC_VERSION`, `BINUTILS_VERSION`, … | pinned | Source versions |

## Using the tools as an API

Each tool is a standard **Emscripten module**. You load the module, write
input files into its in-memory virtual filesystem (`Module.FS`), call the
tool's `main()` with `Module.callMain(args)`, and read the results back out
of `Module.FS`.

The loading pattern (works in Node; in the browser serve the modules over
HTTP and let Emscripten fetch the `.wasm`):

```js
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const WASM_DIR = "public/wasm-toolchain";

// Emscripten modules detect Node at runtime and read their .wasm from disk,
// so we pass them a require() shim (fs/path/crypto) plus the module dir.
const nodeFs = (await import("node:fs")).default;
const nodePath = (await import("node:path")).default;
const nodeCrypto = (await import("node:crypto")).default;
const makeRequire = () => {
  const mods = { fs: nodeFs, path: nodePath, crypto: nodeCrypto };
  return (n) => {
    const m = n.replace(/^node:/, "");
    if (!mods[m]) throw new Error('unsupported require("' + n + '")');
    return mods[m];
  };
};
const loadFactory = (jsBase, exportName) => {
  const path = join(WASM_DIR, jsBase);
  const text = readFileSync(path, "utf8").replace(/^#!.*?\n/, "");
  return new Function("require", "__dirname", "__filename",
    text + `\nreturn typeof ${exportName} !== 'undefined' ? ${exportName} : (typeof createModule !== 'undefined' ? createModule : null);`
  )(makeRequire(), dirname(path), path);
};
const makeTool = async (jsBase, wasmName, exportName) => {
  const factory = loadFactory(jsBase, exportName);
  return await factory({
    noInitialRun: true,
    locateFile: (p) => join(WASM_DIR, p.endsWith(".wasm") ? wasmName : p),
  });
};

const cc1 = await makeTool("cc1.js", "cc1.wasm", "createCc1");
cc1.FS.writeFile("/main.c", "int main(void){ return 0; }\n");
cc1.callMain(["-march=rv32imac_zicsr", "-mabi=ilp32", "-o", "/main.s", "/main.c"]);
const asm = cc1.FS.readFile("/main.s", { encoding: "utf8" });
```

The stages chain: `cc1` → `riscv-as` → `riscv-ld` → `riscv-objcopy`, each
reading the previous stage's output from its `Module.FS`.

## Minimal working example

`examples/minimal-compile.mjs` runs the full pipeline end to end and prints
the result:

```sh
node examples/minimal-compile.mjs
# [1/4] cc1: main.c -> main.s (...)
# [2/4] riscv-as: main.s -> main.o (...)
# [3/4] riscv-ld: main.o -> main.elf (...)
# [4/4] riscv-objcopy: main.elf -> main.hex
# OK: valid RISC-V ELF32 (e_machine = 0xf3)
# ---- Intel HEX ----
# :10000000...
```

It:

1. Compiles a tiny C program with `cc1` to RISC-V assembly.
2. Assembles it with `riscv-as` to an object file.
3. Links it with `riscv-ld` using a small bare-metal linker script.
4. Converts the ELF to Intel HEX with `riscv-objcopy`.
5. Validates the ELF magic and `e_machine == 0xf3` (EM_RISCV).

Point it at a different toolchain directory:

```sh
node examples/minimal-compile.mjs /path/to/wasm-toolchain
```

## Compiling with libc and the full sysroot

The minimal example uses no headers or libraries. To compile real C that
calls libc (e.g. `strlen`), write the sysroot files into `cc1`'s and
`riscv-ld`'s `Module.FS` first, then add the include and lib paths:

```js
// headers into cc1
for (const rel of walk(sysroot + "/include"))
  cc1.FS.writeFile("/include/" + rel, readFileSync(sysroot + "/include/" + rel, "utf8"));
for (const rel of walk(sysroot + "/lib/gcc/riscv32-unknown-elf/15.2.0/include"))
  cc1.FS.writeFile("/usr/local/lib/gcc/riscv32-unknown-elf/15.2.0/include/" + rel, ...);
cc1.callMain(["-march=rv32imac_zicsr", "-mabi=ilp32",
  "-I/include", "-I/usr/local/lib/gcc/riscv32-unknown-elf/15.2.0/include",
  "-o", "/main.s", "/main.c"]);

// libs into the linker
ld.FS.writeFile("/libc.a", readFileSync(sysroot + "/lib/rv32imac_zaamo_zalrsc/ilp32/libc.a"));
ld.FS.writeFile("/libgcc.a", readFileSync(sysroot + "/lib/gcc/riscv32-unknown-elf/15.2.0/rv32imac_zaamo_zalrsc/ilp32/libgcc.a"));
ld.callMain(["-m", "elf32lriscv", "--gc-sections", "-T", "/link.ld",
  "/main.o", "/libc.a", "/libgcc.a", "-o", "/main.elf"]);
```

The same applies in the browser: fetch each sysroot file and
`Module.FS.writeFile` it before calling the tool. `manifest.json` lists
every sysroot file so you know exactly what to fetch.

## Consuming a release in your app

Prebuilt binaries are published as a **Release** asset
(`riscv-wasm-toolchain.tar.gz`). Your app can:

1. Download the tarball (or serve the extracted directory over HTTP/CDN).
2. At runtime, fetch each needed file and `Module.FS.writeFile` it.
3. Cache the files (browser Cache API / IndexedDB) so they download once.

Only fetch the modules you need — `cc1plus` is only required for C++
compiles. `cc1` + `riscv-as` + `riscv-ld` + `riscv-objcopy` + the sysroot is
the minimum for a C pipeline.

## Extending to a board

The module is chip-agnostic. To target a specific MCU family, your app
supplies the board/chip SDK into the tools' `Module.FS` at runtime:

- device headers (register / peripheral),
- startup code,
- the per-chip linker script (memory map),
- device libraries (`lib*.a`).

Then pass the matching `-march` / `-mabi` and the `-I` / `-L` paths. Nothing
in this module is board-specific.

## Reproducibility and releases

- `.github/workflows/build.yml` builds the toolchain from source and
  publishes the Release asset. It runs on **tag** (`v*`) and on manual
  dispatch.
- The release is a single `riscv-wasm-toolchain.tar.gz` containing the whole
  `wasm-toolchain/` directory.

## What is in this repo

- `build-riscv-wasm.sh` — the full build script.
- `examples/minimal-compile.mjs` — the minimal end-to-end example.
- `.github/workflows/build.yml` — CI build + release.

No vendored source, no build artifacts. Everything is produced at build
time.
