# Customs Balancer

Splits ten players into two even teams for League of Legends custom games, based on solo queue rank and lane preferences (main, 2nd, 3rd role and one lane they won't play).

Players are stored in [`players.json`](players.json). The site reads that file from this repo, and anyone with write access can save changes back to it straight from the page.

## Using it

1. Type a name in **Add player**. If the player is already in the database, their rank and roles load automatically. If not, they are added as a new player: set their rank and roles.
2. Tick the ten people who are playing and press **Balance**. **Reroll** gives a different split that is nearly as even.
3. Press **Save to GitHub** to write new or edited players to `players.json`, so everyone gets them next time.

Changes you haven't saved stay in your browser. **Download** gives you the updated `players.json` if you'd rather commit it yourself.

## Publishing on GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo go to **Settings → Pages**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, and save.
3. After a minute the site is live at `https://<owner>.github.io/<repo>/`.

On GitHub Pages the site works out which repo it belongs to from its URL. If you host it elsewhere, fill in `owner` and `repo` in [`config.js`](config.js).

Anyone can open the site, see the database and balance teams. Saving needs a GitHub token with write access to the repo.

## Saving: tokens and access

Each person who wants to save creates their own token and pastes it into **Connect GitHub** on the site. The token is stored only in that person's browser. Never commit a token to the repo: GitHub revokes leaked tokens, and anyone could use it to edit the repo.

**Repo owner:** create a [fine-grained token](https://github.com/settings/personal-access-tokens/new). Under *Repository access* choose *Only select repositories* and pick this repo. Under *Permissions* set *Contents* to *Read and write*.

**Friends:** add them under **Settings → Collaborators** first. Fine-grained tokens may not let you pick a repo that belongs to someone else's personal account. If a friend can't select the repo when creating their token, either:

- **Move the repo into a free GitHub organization** and add your friends as members (recommended). They then create a fine-grained token with the organization as *Resource owner*. The org owner may have to approve each token under **Organization settings → Personal access tokens**.
- **Use a classic token** with the `public_repo` scope. It is simpler, but it can write to every public repo that friend has access to, so it's less safe.

## How the rating works

| | Rating |
|---|---|
| Each division | 100 (Iron IV = 0, Gold IV = 1,200, Diamond I = 2,700) |
| Master / Grandmaster / Challenger | 2,800 / 3,200 / 3,600 |

On a lane other than their main, a player counts for less:

| Lane | Cost |
|---|---|
| 2nd role | −100 |
| 3rd role | −175 |
| Fill (via 2nd/3rd slot) | −200 |
| Main role set to Fill | −50 on every lane |
| Any other lane | −250 |
| "Won't play" lane | only used if there is no other way to fill both teams |

The balancer tries all 126 possible 5v5 splits. For each team it finds the best lane assignment, then picks the split with the smallest strength gap, with a small extra cost for putting people off-role.

## Files

- `index.html`, `style.css`, `app.js`: the site
- `config.js`: optional repo settings
- `players.json`: the player database
