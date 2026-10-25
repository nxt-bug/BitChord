#!/usr/bin/env python3
"""Patches the generated Capacitor iOS project for a music player.

Run after `cap add ios`. Each step fails loudly when the template isn't what it
expects, so a Capacitor update that moves things breaks the build visibly
instead of shipping an app that silently stops when the screen locks.

1. Info.plist: UIBackgroundModes = audio (keeps playing with the screen off).
2. AppDelegate.swift: AVAudioSession category .playback (plays with the silent
   switch on, and keeps the audio session alive in the background).
3. A view controller subclass that lets the web view start audio without a tap
   (the next track starts on its own) and play inline.
"""
import pathlib
import plistlib
import re
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "ios/App")


def die(message: str) -> None:
    sys.exit(f"patch-ios: {message}")


# 1. Background audio -----------------------------------------------------------------------
plist_path = root / "App" / "Info.plist"
if not plist_path.is_file():
    die(f"{plist_path} not found")
with plist_path.open("rb") as f:
    plist = plistlib.load(f)
modes = plist.setdefault("UIBackgroundModes", [])
if "audio" not in modes:
    modes.append("audio")
plist["CFBundleDisplayName"] = "BitChord"
with plist_path.open("wb") as f:
    plistlib.dump(plist, f)

# 2 + 3. Audio session and the view controller ----------------------------------------------
delegate_path = root / "App" / "AppDelegate.swift"
if not delegate_path.is_file():
    die(f"{delegate_path} not found")
source = delegate_path.read_text()

if "BitChordViewController" not in source:
    source, count = re.subn(
        r"(didFinishLaunchingWithOptions[^\n]*\{\n)",
        r"\1        BitChordAudio.activate()\n",
        source,
        count=1,
    )
    if count != 1:
        die("didFinishLaunchingWithOptions not found in AppDelegate.swift")
    source = "import AVFoundation\nimport Capacitor\nimport WebKit\n" + source
    source += '''

/// Plays through the silent switch and keeps the session for background audio.
enum BitChordAudio {
    static func activate() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [])
        try? session.setActive(true)
    }
}

/// The web view may start audio without a tap (the next track, a crossfade) and play inline.
class BitChordViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.allowsInlineMediaPlayback = true
        return configuration
    }
}
'''
    delegate_path.write_text(source)

storyboard_path = root / "App" / "Base.lproj" / "Main.storyboard"
if not storyboard_path.is_file():
    die(f"{storyboard_path} not found")
storyboard = storyboard_path.read_text()
if "BitChordViewController" not in storyboard:
    pattern = r'customClass="CAPBridgeViewController"\s+customModule="Capacitor"'
    storyboard, count = re.subn(
        pattern,
        'customClass="BitChordViewController" customModule="App" customModuleProvider="target"',
        storyboard,
    )
    if count != 1:
        die("CAPBridgeViewController not found in Main.storyboard")
    storyboard_path.write_text(storyboard)

print("patch-ios: ok")
