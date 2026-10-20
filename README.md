# MEDHAS autopost

Posts the Instagram grid days to **Instagram and Facebook by itself**, one day per day at 7:50 PM IST, with captions and first comments. GitHub Actions does the posting; GitHub Pages hosts the media (Instagram downloads it from a public link) and the planner page.

Planner: https://sriram-satuluri.github.io/medhas-autopost/

## How it decides what to post

- Each day in `queue.json` is one grid row: **right carousel → reel → left carousel**. Posted in that order, the row reads Left, Middle, Right on the profile.
- The days are in colour order: green first, then Ashoka blue, then sandalwood into saffron. The first posted sits lowest, so the finished profile reads **saffron over white/blue over green**, like the flag.
- Every 15 minutes the bot checks. After `post_time` it posts the **next approved day**, once per date. Days with `"approved": false` are skipped.
- If the bot misses a day (GitHub outage, paused), it never doubles up; the queue simply moves on a day.
- If a post fails, the run goes red (GitHub emails you) and the next run retries from the same post, so the grid order is kept. After 8 failed tries on one platform it gives up on that platform for that day and moves on.

## Everyday use

| Want to | Do |
|---|---|
| See what goes out when | Open the planner |
| Hold, approve, reorder, pause | Planner → **Connect GitHub to edit** (fine-grained token, this repo only, *Contents: read and write*) |
| Change a caption or first comment | Planner → **Edit captions on GitHub**, edit `queue.json`, commit |
| Post the next day right now | Actions → Autopost → Run workflow → `now` |
| Check everything without posting | Actions → Autopost → Run workflow → `dry-run` |
| Skip a date (e.g. Diwali) | add `"2026-11-08"` to `settings.skip_dates` |
| Change the time | `settings.post_time` (24 h, IST) |

`status.json` is written by the bot only: what went out, links, errors, token health. Do not edit it by hand unless you want a day re-posted (delete that day's entry).

## The Meta token

The bot needs one secret, `META_PAGE_TOKEN`: a Page access token for the **Medhas** Facebook Page with `instagram_content_publish`, `instagram_manage_comments`, `pages_manage_posts`, `pages_manage_engagement`, `pages_read_engagement`. The token from Social Studio already has these.

Page tokens stop working when the user login behind them reaches its *data access expiry* (about 90 days). The planner shows that date. For a token that never needs renewing, make a **System User** in Meta Business Settings → Users → System users, give it the Medhas Page and Instagram account, generate a token with the permissions above, and replace the secret:

```
gh secret set META_PAGE_TOKEN --repo sriram-satuluri/medhas-autopost
```

## Adding more days

Days are built from the Remotion project by `S:\Projects\MEDHAS\social\autopost-tools\build_queue.py` (media + captions from each day's content pack). Add the new key to `KEEP`, re-run it, commit and push. `approved` flags and settings in the existing `queue.json` are kept.

*MEDHAS supports clinical documentation, review, and clinic operations. Clinical decisions remain the responsibility of the treating practitioner.*
