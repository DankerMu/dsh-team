#!/bin/sh
# Entrypoint of dsh-team-documentserver-net (#624), which owns the bundled Document Server's network
# namespace: inbound only loopback, replies and TCP 80 (IPv6 also ICMPv6), so instances never reach
# docservice's 8000. Any failure exits before the ready marker, so the Document Server never starts
# (Office unavailable) rather than starting exposed.
set -eu
READY=/run/dsh-team/firewall-ready
rm -f "$READY"

# $1 is iptables or ip6tables; each further argument is one more accepted match.
firewall() {
  tool=$1
  shift
  set -- "-i lo" "-m conntrack --ctstate ESTABLISHED,RELATED" "-p tcp --dport 80" "$@"
  # Word splitting is intended: each match is a fixed list of words.
  # shellcheck disable=SC2086
  for match in "$@"; do "$tool" -A INPUT $match -j ACCEPT; done
  "$tool" -P INPUT DROP
  # shellcheck disable=SC2086
  for match in "$@"; do "$tool" -C INPUT $match -j ACCEPT; done
  [ "$("$tool" -S INPUT | head -n 1)" = "-P INPUT DROP" ]
}

firewall iptables
# Skipped only on a kernel without IPv6; any other IPv6 failure stops the holder.
if [ -e /proc/net/if_inet6 ]; then firewall ip6tables "-p ipv6-icmp"; fi
touch "$READY"

# PID 1 ignores an untrapped SIGTERM: exit at once on `docker stop`.
trap 'exit 0' TERM INT
sleep infinity &
wait
