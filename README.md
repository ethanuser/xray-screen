# X-Ray Scanner

A Halloween costume app for an iPad worn on the chest, screen facing out.

**Live:** https://ethanuser.github.io/xray-screen/ (open it in Safari on the iPad, tap Start, allow the camera).

- **Subject scan:** the front camera finds the people in front of you and shows a real anatomical skeleton moving with each of them, including every finger bone when their hands are in view. (`?skeleton=2d` swaps in a simpler drawn skeleton.)
- **Self-diagnostic:** the screen becomes a window into your chest: real ribs, spine, a beating heart, breathing lungs, liver and a stomach full of brown rice. The view follows the viewer's head, like looking through glass.

Everything runs on the device in the browser (MediaPipe for body pose, hands and face; three.js for rendering). Nothing is recorded or uploaded.

## How the skeleton is rigged

The bones are real meshes from BodyParts3D, grouped into rigid pieces (skull, ribcage, pelvis, each long bone, each metacarpal and phalanx). Bones don't bend, so each piece is attached to the tracked joints: the torso, pelvis, head, hands and feet take their full rotation from three landmarks each, and limb and finger bones swing from their parent to point at the next joint. Rotations come from MediaPipe's 3D world landmarks, so arms pointing at the camera foreshorten properly. Each person and each hand is then fitted onto where it appears in the camera image.

## Rebuilding the anatomy

`models/anatomy.glb` and `models/rig.json` are generated. To rebuild them, download `partof_BP3D_4.0_obj_99.zip` and `partof_element_parts.txt` from the [BodyParts3D archive](https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/), unzip into `.cache/bp3d/`, then run:

```bash
node scripts/build-anatomy.mjs .cache/bp3d
```

## Run it locally

```bash
npm install
node serve.mjs
```

The server prints two addresses:

- **Mac:** `http://localhost:8080`. Open it in Safari or Chrome and allow the camera.
- **iPad:** `https://<your-mac-ip>:8443`, on the same Wi-Fi. The certificate is self-signed, so Safari warns first: tap **Show Details → visit this website**, then allow the camera.

For fullscreen on the iPad, use **Share → Add to Home Screen** and open it from the icon. Turn on **Guided Access** (Settings → Accessibility) so taps can't leave the app.

## Controls

- **Thumbs up** (Subject scan): hold a thumbs-up for a moment and it takes a photo, no touching needed (at most one every 8 s).
- **Pose game** (Subject scan): five rounds: two poses, one yoga pose and two moves. Poses (Touchdown, Egyptian, Dab, T-pose to assert dominance, Lightning Bolt, Shrug…): copy the stick figure like a mirror and hold it for half a second. Yoga (Tree pose, Flamingo, Big toe hold, Standing split, Goddess squat): needs your legs in view; either leg works, and it's forgiving. Moves (6-7, Crank That, Whip it, Wave hello, Raise the roof, Floss, Chicken dance, Jumping jacks, Slow clap): the figure animates the move; do it once within 12 seconds. Faster scores more. Everyone in view plays and the best match counts. Every match is photographed (target pose, photo and X-ray side by side), and at the end a gallery lets you tap to discard any, then save the rest. Ends with a score and a rank.
- **Photo** (Subject scan): a spoken 3-2-1 over an X-ray charge-up sound, then two pictures of the same instant: the people, and the people as an X-ray. Save them from the panel (on iPad, Save Image in the share sheet, or press and hold a photo).
- **Parallax** (Self-diagnostic): turn the head-tracked window effect on or off. Off also stops the camera tracking in that mode, which saves battery.
- **Drag and pinch** (Self-diagnostic): pan and zoom the anatomy to line it up with where the iPad sits on your body; scroll or trackpad-pinch on a Mac. Remembered on the device. **Reset view** goes back to the default.
- **Full screen**: hides Safari's bars. iPadOS doesn't let websites hide the status bar (time, battery); see Tips.
- **Hold 1 second:** switch between Subject scan and Self-diagnostic (a bar fills along the bottom).
- **Attract mode:** with nobody in view for 3 s, a skeleton beckons and the screen says "Step into the scanner".
- **Lean in too close** in Subject scan and the machine jumpscares you (a face filling about a third of the frame for a moment). It re-arms once the face backs off.
- **Keys (Mac):** `1` Subject scan, `2` Self-diagnostic, `p` photo, `g` pose game, `f` full screen, `s` jumpscare now, `m` mirror, `d` debug.

## Tuning (URL options)

| Option | Default | What it does |
|---|---|---|
| `fps=30` | 30 | Drawing frame-rate cap (lower saves battery) |
| `vision=15` | 15 | Tracking rate cap (lower saves battery, adds lag) |
| `mode=me` | Subject scan | Start in Self-diagnostic |
| `scare=0` | on | Turn off the jumpscare |
| `scareAt=0.32` | 0.32 | Face width (fraction of the frame) that triggers it |
| `pose=lite` | full | Faster but jumpier body tracking |
| `mirror=0` | mirrored | Show Subject scan unmirrored |
| `hfov=70` | 70 | Front camera field of view in degrees; fix this if parallax feels too strong or weak |
| `ppi=132` | 132 iPad / 113 Mac | Screen CSS pixels per inch, used to size the chest at real scale |
| `chest=-0.04` | -0.04 | Body height (m) of the screen centre relative to the bottom of the sternum; raise it to show more heart |
| `scale=1.2` | 1.2 | Make the chest anatomy bigger or smaller |

Test modes without a camera: `?nocam=1` previews Self-diagnostic, and `?fake=1` loads everything and drives Subject scan with a synthetic person and a curling hand (during the pose game the figure copies each target, which demos the photos and gallery).

## Your own sounds

The easiest way: tap **Sounds** on the start screen and pick audio files from the device for any slot, including one per pose and move (it plays when that round starts, instead of the spoken name). Files picked there stay in that browser on that device and are never uploaded, so songs are fine to use.

Or, for sounds you're allowed to publish, drop MP3s into `media/sounds/` with these names (per-pose ones go in `media/sounds/poses/`, e.g. `crank-that.mp3`); any that are missing fall back to the built-in sounds (or silence):

| File | Plays |
|---|---|
| `ambient.mp3` | Looped quietly the whole time (ducked during jumpscares) |
| `attract.mp3` | When the attract mode starts (at most every 30 s) |
| `thumbsup.mp3` | When a thumbs-up is spotted |
| `countdown.mp3` | Replaces the spoken 3-2-1 (about 3 s long) |
| `shutter.mp3` | The moment the photo is taken |
| `gamestart.mp3` | The pose game starts |
| `match.mp3` | A pose is matched |
| `fail.mp3` | A pose runs out of time |

## Your own jumpscare videos

The built-in jumpscare is a 0.5 s burst rendered from the skull model: it rushes from tiny to filling the screen, jaw dropping and eyes burning, under rainbow static, RGB split, tearing and warping, then cuts off dead along with a boosted slice of the scream. Tracking pauses while it plays. To add videos, put them in `media/jumpscares/` and list their file names in `media/jumpscares.json`, for example `["ghost.mp4", "face.mp4"]`. They join the random rotation, play muted through the same distortion, with the scream on top. Use MP4 (H.264) so the iPad can play them.

## Tips

- **Status bar:** iPadOS always shows it for websites, even in full screen or as a Home Screen app. To make it less visible, turn off Settings → Battery → Battery Percentage, or have the costume's frame cover the top ~1 cm of the screen.

## Battery

It draws at 30 fps and tracks at 15 fps instead of the iPad's 120 Hz screen and 30 Hz camera, runs the face mesh on every other tracking frame, uses a 960×540 camera feed and renders at a reduced pixel ratio. Screen brightness is the other big drain; on a dark porch you can turn it down a lot. For a long night, `?fps=24&vision=12&pose=lite` stretches it further.

## Diagnosing tracking problems

- **`?diag=1`** shows the dimmed camera image under the skeleton, with the raw MediaPipe landmarks (red; hollow = low confidence), the smoothed points the skeleton uses (white) and hand points (orange raw, yellow tracked). A panel shows how much each bone's length wobbles (it should be ~0%), how far the skeleton trails the raw points, how many landmarks are low-confidence, and how often the torso jumps. If the red dots are wrong, MediaPipe is mis-tracking; if the red dots are right but the bones aren't, the rig is at fault.
- **Recording:** press `r` to start and stop (or add `?record=20` to record 20 s after Start, handy on the iPad). It downloads `xray-recording-….json` with the raw tracking data for every frame.
- **Replay:** put a recording in `recordings/` and open `?replay=recordings/<file>.json` (add `&diag=1` for the numbers). It runs the exact same pipeline without a camera, so a problem can be reproduced and a fix compared against the same movements. `recordings/synthetic-test.json` is a sample.

## Credits

Anatomy: BodyParts3D, © The Database Center for Life Science, licensed under [CC Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) (older copies of the data say CC BY-SA 2.1 Japan). The meshes were regrouped and simplified for this app.

Scream: `media/static_scream.mp3`, supplied by the project owner.
