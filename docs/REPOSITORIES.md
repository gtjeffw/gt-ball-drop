# The two repositories

GT Ball Drop lives in two Git repositories that carry the same `main` branch:

| Remote name | Repository | Role |
|---|---|---|
| `origin` | `git@github.gatech.edu:IPaT/gt-ball-drop.git` | the primary copy |
| `github` | `git@github.com:gtjeffw/gt-ball-drop.git` | the public copy. CI runs here, and Cloudflare Pages builds <https://gt-ball-drop.jeffwilson.dev> from its `main` |

Work happens in a local clone, and every change is pushed to **both**. Neither repository
pulls from the other by itself.

## Setting up a computer

You need SSH access to both hosts: your GT account on github.gatech.edu and the
`gtjeffw` account on github.com. `ssh -T git@github.gatech.edu` and `ssh -T git@github.com`
should each greet you by name.

```bash
git clone git@github.gatech.edu:IPaT/gt-ball-drop.git
cd gt-ball-drop
git remote add github git@github.com:gtjeffw/gt-ball-drop.git
git fetch github
git remote -v        # origin = github.gatech.edu, github = github.com
```

Then install as usual (Node from `.nvmrc`, then `npm install`).

## Day to day

```bash
git pull origin main          # start from the latest
# ... work, commit ...
git push origin main
git push github main          # also deploys the website and runs CI
```

Pushing to `github` rebuilds the website within a minute or two, and runs the tests in
GitHub Actions. The CI job only runs on github.com; on github.gatech.edu it shows as
skipped.

**Optional: one `git push` for both.** Give `origin` both push URLs (this is per clone):

```bash
git remote set-url --add --push origin git@github.gatech.edu:IPaT/gt-ball-drop.git
git remote set-url --add --push origin git@github.com:gtjeffw/gt-ball-drop.git
```

After that, `git push origin main` pushes to both, and `git remote -v` lists two push
URLs for `origin`. Fetching from `origin` still reads github.gatech.edu only.

## Checking that they match

```bash
git fetch origin && git fetch github
git rev-parse origin/main github/main     # the same hash twice when in step
```

If they differ:

* **One is just behind** (`git log --oneline github/main..origin/main` lists commits, the
  other direction lists none, or the reverse): push the newer `main` to the one behind.
* **Each has commits the other lacks**, for example a pull request merged on github.com
  while something was pushed to github.gatech.edu: bring both into your clone, then push
  the result to both.

  ```bash
  git pull origin main
  git pull github main
  git push origin main
  git push github main
  ```

Don't force-push either repository: the github.com one is public, and others may have
cloned it.

## Changes made on github.com

Pull requests from others, or edits in the GitHub web editor, land on github.com only.
After merging one there:

```bash
git pull github main
git push origin main
```

## Related

* Website build settings (Cloudflare Pages): [DEPLOY.md](DEPLOY.md).
* CI: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
