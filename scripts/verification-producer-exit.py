"""Observe one pre-registered Linux process through a kernel-bound pidfd; never signal it."""
import os
import select
import sys


def main():
    if sys.platform != 'linux' or len(sys.argv) != 2:
        raise RuntimeError('Producer exit observation unavailable')
    descriptor = os.pidfd_open(int(sys.argv[1]))
    try:
        events = select.poll()
        events.register(descriptor, select.POLLIN)
        print('ready', flush=True)
        observed = events.poll()
        if (len(observed) != 1 or observed[0][0] != descriptor or
                not observed[0][1] & select.POLLIN or
                observed[0][1] & (select.POLLERR | select.POLLNVAL)):
            raise RuntimeError('Producer exit observation incomplete')
        print('producer-exit-observed', flush=True)
    finally:
        os.close(descriptor)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Only fixed protocol records cross this boundary; private syscall errors never do.
        sys.exit(1)
