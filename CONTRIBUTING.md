# Contributing to DemonX

Thanks for wanting to help. DemonX controls real machines, so a few extra rules apply.

## 1. Agree to the CLA (once)

DemonX is released under the GPL, and its owner, Prickly Guy Creations (PGC), keeps the option of offering it under other
terms later. So every contributor agrees to the [Contributor License Agreement](CLA.md) once: you keep your copyright, and
you give PGC a broad licence to your contribution. Put the sentence from the end of `CLA.md` in your first pull request.
Pull requests without it cannot be merged.

## 2. Safety comes first

DemonX moves cutters. Please read the "Behaviour that must not regress" list in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before
you change probing, autolevel, jogging, PCB mode, macros, spindle control or controller settings. In short:

- The server decides, the browser displays. A safety rule belongs on the server, so an old tab or a remote phone cannot get
  around it.
- Probing always asks "is the probe connected?" before it moves and "remove the probe" after, and nothing can bypass that.
- Anything that can move the machine or change its settings needs the access PIN when one is set.
- If something is not tested on real hardware, say so in the pull request. Do not describe code you have only read as
  verified.

## 3. Working on it

```bash
npm install
npm run typecheck && npm test          # fast checks, no browser, no hardware
npm run build && npm start             # http://localhost:8080 ; type "simulator" as the port
```

Browser checks are in `e2e/README.md`. Windows package: `npm run package:windows` (in PowerShell use `npm.cmd`).

- Fix a bug by writing a test that fails first, then the fix.
- Commit messages explain why, not only what.
- Keep a pull request to one change. Match the style of the code around it.
- Everything stored and sent between server and browser is in millimetres; inches exist only for display and typed input.

## 4. Pull requests

Describe what changed and why, what you tested (simulator, real machine: which controller), and anything you could not test.
Tick the CLA box in the pull request template.
