# PKU CLI contribution candidates

Base: pkuinfo/pkucli 0ad6dea1802abc98825dc57b07b75da4dee1c9f4 (MIT).

`pkucli-course-read.patch` adds three read-only course commands: `recordings --date --search`, `recording-sessions <course-id>`, and `learning-grades <course-id>`. Outputs are typed JSON, reuse ordinary authorized course sessions, and preserve unpublished or removed recording states. No GUI, desktop session-expiry changes, or media downloader is included.

The isolated checkout used to produce the patch is kept outside this repository (it is a full upstream clone). Three parser tests passed; an actual date/name directory query returned the requested recording course. Full school grading coverage is not established. Global installed `pku` was not modified. No commit was pushed and no PR was created.

`pkucli-bdkj-login.patch` updates the official OAuth callback configuration from HTTP to HTTPS. OnePKU additionally validates the protected login destination and preserves the profile-completion prerequisite; these desktop integration changes are not part of this small configuration patch.

Review the patch file directly. Apply the course patch to the stated base with `git apply --check` before `git apply`.

## Windows portability delta

`pkucli-windows.patch` is an incremental patch against the vendored source in OnePKU commit `ddeb402`, not against the original unmodified upstream SHA above. It adds platform-conditional private-file modes, closes session/cookie writers before replacement, hides Windows ffmpeg consoles, and tests synthetic session/cookie replacement. Paths retain the `vendor/pkucli/` prefix so the patch can be reviewed/applied at the OnePKU root. Adapt these small changes to upstream's current implementation before opening an upstream PR; no upstream PR has been submitted.
