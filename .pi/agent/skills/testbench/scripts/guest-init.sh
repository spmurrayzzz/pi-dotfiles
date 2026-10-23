#!/bin/sh
set -eu
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
mount -t proc -o hidepid=2 proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
ip link set lo up
mkdir -p /workspace
mount -t tmpfs -o size=96m,nodev,nosuid tmpfs /workspace
mount -t tmpfs -o size=32m,nodev,nosuid tmpfs /tmp
mkdir -p /workspace/home /workspace/tmp
printf 'testbench:x:1000:1000:Testbench:/workspace/home:/bin/sh\n' >> /etc/passwd
printf 'testbench:x:1000:\n' >> /etc/group
chown 1000:1000 /workspace /workspace/home /workspace/tmp
chmod 700 /workspace /workspace/home /workspace/tmp
stty -F /dev/console raw -echo
ulimit -c 0
ulimit -t 60
ulimit -f 32768
ulimit -n 128
exec env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/workspace/home TMPDIR=/workspace/tmp LANG=C.UTF-8 TZ=UTC /usr/bin/node --max-old-space-size=256 /opt/testbench/worker.mjs < /dev/console > /dev/console 2> /dev/console
