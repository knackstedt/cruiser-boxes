---
title: USB passthrough
description: Enumerating host USB devices and hotplugging them into a VM.
---

Cruiser passes USB devices to guests with QEMU `usb-host` — enumerate on the
host, then attach by vendor/product id.

```sh
bun run cli -- usb ls
# 046d:c52b  bus1/dev4  Logitech Unifying Receiver
# 1050:0407  bus3/dev2  Yubico YubiKey OTP+FIDO+CCID  (no rw perm)

bun run cli -- usb attach myvm 1050:0407
# attached as cru-usb-1050-0407

bun run cli -- usb detach myvm cru-usb-1050-0407
```

Attach/detach are live QMP `device_add`/`device_del` hotplug operations —
no reboot needed.

## Boot-time attach

`usb.autoAttach[]` in `vm.json` attaches devices at QEMU launch instead of
on demand — entries carry `vendorId`, `productId`, optional `serial` (for
distinguishing identical devices), and `atBoot`.

## Permissions

`usb ls` flags `(no rw perm)` when your user can't open the device node —
most distros ship `/dev/bus/usb` root-only. Fix once with a udev rule:

```udev
# /etc/udev/rules.d/99-cruiser-usb.rules
SUBSYSTEM=="usb", GROUP="plugdev", MODE="0660"
```

```sh
sudo udevadm control --reload && sudo udevadm trigger
sudo usermod -aG plugdev $USER   # if not already; relogin
```

`doctor` reports how many devices lack rw and prints this fix.

:::caution
Attaching the device your host keyboard/mouse is on will detach it from the
host. Prefer attaching by `serial` for devices you always want in the VM,
and leave input devices alone.
:::
