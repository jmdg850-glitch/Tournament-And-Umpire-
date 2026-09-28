// Early release gate: is there anything to release at all?
//
// A clean working tree is NOT "nothing to release" when main already has
// committed source that origin/main doesn't have yet — those commits ship with
// the release (the release commit adds only the version bumps on top, and the
// plain `git push origin main` publishes them all). Pure: the caller runs git.
//
//   dirtyCount  number of `git status` entries
//   remoteSha   origin/main from `git ls-remote` ("" if it could not be read)
//   unpushed    ["<sha> <subject>", ...] for remoteSha..HEAD, or null when that
//               range can't be computed (origin has a commit this checkout lacks)
export function decideReleaseStart({ dirtyCount, remoteSha, unpushed }) {
  if (dirtyCount > 0) return { proceed: true, message: "" };
  if (!remoteSha) {
    return {
      proceed: false,
      message: "No changes in the working tree, and origin/main could not be read to look for unpushed commits — release skipped. (Check the network/origin, then re-run.)",
    };
  }
  if (unpushed === null) {
    // Let the preflight's origin check explain it (fetch and reconcile) rather
    // than reporting a misleading "no changes".
    return { proceed: true, message: "Working tree is clean; origin/main has commits this checkout lacks — continuing so the preflight can report it." };
  }
  if (unpushed.length === 0) {
    return {
      proceed: false,
      message: "No changes in the working tree — release skipped. (Commit the source changes to ship first if they are not committed yet, or pass them via --allow=.)",
    };
  }
  return {
    proceed: true,
    message: `Working tree is clean; releasing ${unpushed.length} committed change(s) not yet on origin/main:\n${unpushed.map((c) => `  ${c}`).join("\n")}`,
  };
}
