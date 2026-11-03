# Releasing the Frndship client

Releases go to GitHub Releases on `Sysonn/frndship-client`. Installed clients update themselves from there.

1. Bump the version. Clients only update to a higher version number.

   ```powershell
   npm version <new-version> --no-git-tag-version
   ```

2. Commit everything and make sure `git status` is clean. The build packages your working files, including anything uncommitted.
3. Push `main`. The release tag is created on GitHub, so the commit needs to be there first.
4. Set a GitHub token that can write to the repo, then publish:

   ```powershell
   $env:GH_TOKEN = "<token>"
   npm run release
   ```

5. Open the repo's Releases page. If the new release is a draft, publish it. Clients can't see drafts.
6. Check that the release has all three files: `Frndship_Setup.exe`, `Frndship_Setup.exe.blockmap` and `latest.yml`.

## Local development

- `npm start` loads the local dev server at `http://localhost:5173`.
- `$env:FRNDSHIP_URL = "https://frndship.app"; npm start` runs your local client code against production. Run `Remove-Item Env:FRNDSHIP_URL` to go back to the dev server.
- Installed builds always load production and ignore `FRNDSHIP_URL`.
- DevTools (F12 or Ctrl+Shift+I) only work under `npm start`.
