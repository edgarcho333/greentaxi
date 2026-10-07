#!/usr/bin/env bash
set -euo pipefail

test_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
android_dir=$(cd -- "$test_dir/.." && pwd)
classes_dir=$(mktemp -d "${TMPDIR:-/tmp}/greentaxi-live-state.XXXXXX")
trap 'rm -rf -- "$classes_dir"' EXIT

if [[ -n "${JAVA_HOME:-}" ]]; then
  javac_bin="$JAVA_HOME/bin/javac"
  java_bin="$JAVA_HOME/bin/java"
else
  javac_bin=javac
  java_bin=java
fi

"$javac_bin" -encoding UTF-8 -d "$classes_dir" \
  "$android_dir/app/src/main/java/ge/greentaxi/calls/LiveCallState.java" \
  "$android_dir/app/src/main/java/ge/greentaxi/calls/CallReconciler.java" \
  "$android_dir/app/src/main/java/ge/greentaxi/calls/CallerPhone.java" \
  "$test_dir/LiveCallStateTest.java" \
  "$test_dir/CallReconcilerTest.java" \
  "$test_dir/CallerPhoneTest.java"
"$java_bin" -cp "$classes_dir" ge.greentaxi.calls.LiveCallStateTest
"$java_bin" -cp "$classes_dir" ge.greentaxi.calls.CallReconcilerTest
"$java_bin" -cp "$classes_dir" ge.greentaxi.calls.CallerPhoneTest
python3 "$test_dir/queue_schema_test.py"
