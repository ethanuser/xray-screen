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

- **Hold 1 second:** switch between Subject scan and Self-diagnostic (a bar fills along the bottom).
- **Lean in too close** in Subject scan and the machine jumpscares you (a face filling ~45% of the frame for a moment). It re-arms once the face backs off.
- **Keys (Mac):** `1` Subject scan, `2` Self-diagnostic, `s` jumpscare now, `m` mirror, `d` debug.

## Tuning (URL options)

| Option | Default | What it does |
|---|---|---|
| `mode=me` | Subject scan | Start in Self-diagnostic |
| `scare=0` | on | Turn off the jumpscare |
| `scareAt=0.45` | 0.45 | Face width (fraction of the frame) that triggers it |
| `pose=lite` | full | Faster but jumpier body tracking |
| `mirror=0` | mirrored | Show Subject scan unmirrored |
| `hfov=70` | 70 | Front camera field of view in degrees; fix this if parallax feels too strong or weak |
| `ppi=132` | 132 iPad / 113 Mac | Screen CSS pixels per inch, used to size the chest at real scale |
| `chest=0` | 0 | Body height (m) of the screen centre relative to the bottom of the sternum; raise it to show more heart |
| `scale=1` | 1 | Make the chest anatomy bigger or smaller |

Test modes without a camera: `?nocam=1` previews Self-diagnostic, and `?fake=1` loads everything and drives Subject scan with a synthetic person and a curling hand.

## Your own jumpscare videos

The built-in jumpscare is a 0.5 s burst rendered from the skull model: it rushes from tiny to filling the screen, jaw dropping and eyes burning, under rainbow static, RGB split, tearing and warping, then cuts off dead along with a boosted slice of the scream. Tracking pauses while it plays. To add videos, put them in `media/jumpscares/` and list their file names in `media/jumpscares.json`, for example `["ghost.mp4", "face.mp4"]`. They join the random rotation, play muted through the same distortion, with the scream on top. Use MP4 (H.264) so the iPad can play them.

## Diagnosing tracking problems

- **`?diag=1`** shows the dimmed camera image under the skeleton, with the raw MediaPipe landmarks (red; hollow = low confidence), the smoothed points the skeleton uses (white) and hand points (orange raw, yellow tracked). A panel shows how much each bone's length wobbles (it should be ~0%), how far the skeleton trails the raw points, how many landmarks are low-confidence, and how often the torso jumps. If the red dots are wrong, MediaPipe is mis-tracking; if the red dots are right but the bones aren't, the rig is at fault.
- **Recording:** press `r` to start and stop (or add `?record=20` to record 20 s after Start, handy on the iPad). It downloads `xray-recording-….json` with the raw tracking data for every frame.
- **Replay:** put a recording in `recordings/` and open `?replay=recordings/<file>.json` (add `&diag=1` for the numbers). It runs the exact same pipeline without a camera, so a problem can be reproduced and a fix compared against the same movements. `recordings/synthetic-test.json` is a sample.

## Credits

Anatomy: BodyParts3D, © The Database Center for Life Science, licensed under [CC Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) (older copies of the data say CC BY-SA 2.1 Japan). The meshes were regrouped and simplified for this app.

Scream: `media/static_scream.mp3`, supplied by the project owner.
