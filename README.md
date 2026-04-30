# pi-dotfiles

Source-controlled pi configuration.

## Install

```sh
make install
```

This copies everything under this repo's `.pi/` directory into `~/.pi/`.
Existing changed files are backed up under:

```text
~/.pi/.install-backups/<timestamp>/
```

JSON config files are merged instead of blindly overwritten.

To install into a different pi home:

```sh
make install PI_HOME=/path/to/.pi
```

## Test

```sh
make test
```
