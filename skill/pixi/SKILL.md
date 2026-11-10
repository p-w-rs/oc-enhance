---
name: pixi
description: Use Pixi (pixi.sh) for Python and other toolchains — single-file scripts with inline dependencies (pixi run --script), Pixi workspaces for projects, adding conda and PyPI packages, tasks, multiple environments and platforms, and replacing pip/venv/conda/uv/system installs. Load before running Python or setting up a project's toolchain.
---

# Working with Pixi

Pixi gives every script and project its own locked, reproducible environment (conda-forge and PyPI packages),
without touching the system. Use it instead of system Python, `pip`, `venv`, `conda`, `uv` or Homebrew installs.

## Rules

- **Python only through Pixi.** Never run `python`, `python3`, `pip`, `pip3`, `uv`, `conda`, `virtualenv` or
  `python -m venv` directly. Use `pixi run --script file.py` for a single file, or `pixi run …` inside a workspace.
- **Projects that use Python have a Pixi workspace** (`pixi.toml`, or `[tool.pixi]` in `pyproject.toml`) and a
  committed `pixi.lock`.
- **Other languages:** prefer Pixi-managed toolchains (C/C++ compilers, CMake, Go, Rust, Node, Zig, …) over system
  ones, so the project builds the same on every machine. Don't force a migration on an existing project that uses
  another tool unless the user asks.
- Declare dependencies with `pixi add`; don't `pixi run pip install` (it bypasses the lock file).
- Run with `--locked` when a lock file exists (CI, reproducing): it fails instead of silently re-solving.

## Single-file scripts (no project)

```sh
pixi init --script tool.py                 # writes an inline metadata block (PEP 723)
pixi add --script tool.py numpy            # conda-forge package
pixi add --script tool.py --pypi rich      # PyPI package
pixi run --script tool.py arg1 arg2        # creates/caches the environment, then runs
```

The block at the top of the file looks like:

```python
# /// script
# requires-python = ">=3.12"
# dependencies = ["rich"]          # PyPI
#
# [tool.pixi.dependencies]
# numpy = "*"                      # conda-forge
# ///
```

Make a script runnable on its own with the shebang `#!/usr/bin/env -S pixi run --script` (then `chmod +x`).
For a one-off command with a package, without a file: `pixi exec --spec python=3.12 --spec numpy python -c "…"`.

## Projects

```sh
pixi init                                  # pixi.toml in the current folder (pixi init --format pyproject for pyproject.toml)
pixi add python=3.12 numpy pandas          # conda-forge
pixi add --pypi some-package               # PyPI
pixi add --feature test pytest             # an optional feature
pixi workspace platform add linux-64 osx-arm64   # lock for every platform the team uses
pixi run python main.py                    # anything in the environment
pixi task add test "pytest -q"             # named tasks; run with: pixi run test
pixi run --locked test
pixi shell                                 # interactive shell with the environment active
pixi list / pixi tree                      # what is installed and why
pixi update / pixi upgrade                 # newer compatible versions / bump constraints
```

- Commit `pixi.toml` (or `pyproject.toml`) **and** `pixi.lock`; ignore `.pixi/`.
- Several environments: define features (`[feature.cuda.dependencies]`) and `[environments] cuda = ["cuda"]`; run
  with `pixi run -e cuda …`.
- Tasks can depend on each other: `test = { cmd = "pytest", depends-on = ["build"] }`.
- Local editable package: `pixi add --pypi mypkg --path . --editable`.

## Converting an existing project

- `requirements.txt` / `environment.yml`: `pixi init --import environment.yml`, or `pixi init` then `pixi add` the
  listed packages (prefer conda-forge names; use `--pypi` for packages that are only on PyPI).
- `pyproject.toml` with dependencies: `pixi init --format pyproject` adds `[tool.pixi]` sections next to them.
- Replace instructions such as `pip install -r requirements.txt && python app.py` with Pixi tasks.

## Other toolchains

```sh
pixi add cxx-compiler cmake ninja          # C/C++
pixi add go                                # Go
pixi add rust                              # Rust (cargo, rustc)
pixi add nodejs                            # Node and npm
pixi run cmake -B build && pixi run cmake --build build
```

Global command-line tools for the user (not for a project): `pixi global install ripgrep` (only when asked).

## Troubleshooting

- "lock file not up to date": run `pixi install` (or `pixi lock`) and commit the new `pixi.lock`; with `--locked`,
  that is why it failed.
- A package is not on conda-forge: `pixi search name` to check, then `pixi add --pypi name`.
- Wrong platform in the lock: `pixi workspace platform add <platform>`.
- Clean caches and environments: `pixi clean` (this workspace), `pixi clean cache` (global download cache).
