#!/usr/bin/env bash
# Emulator smoke test for MyoLift with two demo sensors:
# place sensors -> calibrate -> start workout -> auto-detected sets -> background -> end -> summary -> set detail.
# Usage: tools/android_smoke.sh path/to/app.apk [outdir]
set -uo pipefail
APK=$1; OUT=${2:-smoke}; PKG=com.mohitburkule.myolift
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
fail() { echo "FAIL: $*"; adb exec-out screencap -p > "$OUT/failure.png"; adb logcat -d > "$OUT/logcat.txt"; exit 1; }
shot() { adb exec-out screencap -p > "$OUT/$1.png"; echo "screenshot $1"; }
dump() {
  rm -f "$OUT/ui.xml"; adb shell rm -f /sdcard/ui.xml
  for i in 1 2 3 4 5 6; do
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb pull /sdcard/ui.xml "$OUT/ui.xml" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "(ui dump failed)"
}
find_xy() { python3 "$HERE/ui_find.py" "$OUT/ui.xml" "$1"; }
has() { dump; find_xy "$1" >/dev/null; }
tap() {
  for i in 1 2 3 4 5; do
    dump
    if xy=$(find_xy "$1"); then adb shell input tap $xy; echo "tap '$1' at $xy"; return 0; fi
    sleep 2
  done
  fail "button '$1' not found"
}
# tap a button that may be below the fold: scroll down until it appears
tap_scroll() {
  for i in 1 2 3 4 5 6; do
    dump
    if xy=$(find_xy "$1"); then adb shell input tap $xy; echo "tap '$1' at $xy"; return 0; fi
    adb shell input swipe 160 520 160 200 400; sleep 1
  done
  fail "button '$1' not found (after scrolling)"
}
alive() { adb shell pidof $PKG >/dev/null || fail "app process died"; }
scroll() { adb shell input swipe 160 520 160 160 400; sleep 1; }

adb install -r -g "$APK" || fail "install"
adb logcat -c
adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 15
alive; shot 01-start
has "Put the sensors on" || fail "first-run screen not shown"

tap "Try demo sensors"; sleep 4; shot 02-sensors
tap "Use this sensor"; sleep 2
tap "Use this sensor"; sleep 2; shot 03-placed
tap "Take reference photo"; sleep 5; alive; shot 03b-camera
adb shell input keyevent KEYCODE_BACK; sleep 2
tap_scroll "Calibrate these positions"; sleep 2
tap "Start"; sleep 42; shot 04-calibration
has "Results" || fail "calibration results not shown"
has "New reference" || fail "placement check result not shown"
tap_scroll "Save"; sleep 2
adb shell input keyevent KEYCODE_BACK; sleep 2
shot 05-ready

# the bar during a workout is [Sensors][Calibrate][Camera][End] (equal widths, 16dp padding, 8dp gaps);
# dumps fail while recording, so compute the positions from the screen size now
dump
read SX SY < <(find_xy "Sensors") || fail "Sensors button"
WPX=$(adb shell wm size | grep -o '[0-9]*x' | tail -1 | tr -d x)
DEN=$(adb shell wm density | grep -o '[0-9]*' | tail -1)
read CAM_X END_X < <(awk -v w=$WPX -v d=$DEN 'BEGIN{d=d/160; b=(w-32*d-24*d)/4; printf "%d %d\n", 16*d+2*(b+8*d)+b/2, w-16*d-b/2}')
END_Y=$SY
echo "bar: camera x=$CAM_X end x=$END_X y=$END_Y"
tap "▶ Start"; sleep 5; alive
adb shell dumpsys activity services $PKG | grep -q "RecordingService" || fail "foreground service not running"
echo "workout recording"
sleep 45; shot 06-first-set
sleep 35; shot 07-sets; alive
adb shell input tap $CAM_X $END_Y; sleep 4; shot 07b-workout-camera; alive
adb shell input keyevent KEYCODE_BACK; sleep 3; alive

adb shell input keyevent KEYCODE_HOME; sleep 15; alive
adb shell dumpsys activity services $PKG | grep -q "isForeground=true" || fail "service not foreground in background"
echo "still recording in background"
adb shell monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null; sleep 4; shot 08-back

adb shell input tap $END_X $END_Y; echo "tap End at $END_X $END_Y"
sleep 20; alive; shot 09-summary
has "Set 1" || { scroll; has "Set 1"; } || fail "no sets in the workout summary"
tap_scroll "Raw data (zip)"; sleep 8; shot 09b-export; alive
adb shell input keyevent KEYCODE_BACK; sleep 2
for i in 1 2 3; do adb shell input swipe 160 200 160 560 300; done; sleep 1
tap_scroll "Set 1"; sleep 5; shot 10-set-detail
found=0; for i in 1 2 3 4; do if has "Fix this set"; then found=1; break; fi; scroll; done
[ $found = 1 ] || fail "set detail incomplete"
shot 11-set-detail-bottom
adb shell input keyevent KEYCODE_BACK; sleep 2
adb shell input keyevent KEYCODE_BACK; sleep 2
tap "History"; sleep 3; shot 12-history
alive
tap "Lab"; sleep 2; has "Experiments" || fail "Lab tab"
has "Save day to Downloads" || has "No experiments yet." || fail "Lab day export"
tap "+ New experiment"; sleep 3; shot 13-experiment
has "Switch camera" || has "Allow camera" || fail "experiment screen"
adb shell input keyevent KEYCODE_BACK; sleep 2
alive

adb logcat -d > "$OUT/logcat.txt"
if grep -A6 "FATAL EXCEPTION" "$OUT/logcat.txt" | grep -q "$PKG"; then grep -A20 "FATAL EXCEPTION" "$OUT/logcat.txt" | head -40; fail "app crashed"; fi
if grep -E "ReactNativeJS.*(Error|TypeError|undefined is not)" "$OUT/logcat.txt" | head -10 | grep .; then fail "JavaScript errors in logcat"; fi
echo "SMOKE TEST PASSED"
