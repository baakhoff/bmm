# Connecting X

BMM posts to X through X's official API, with a developer app that you own.
You create the app once per BMM instance; every profile then connects its X
accounts through it.

## What it costs

X's API is pay-per-use: you buy credits in the X Developer Console and each
call draws them down. Creating a post costs a few cents at most, and X
charges noticeably more for a post that contains a link. Check the current
rates on [X's pricing page](https://docs.x.com/x-api/getting-started/pricing)
and set a spending limit in the console. BMM warns you when a post contains a
link, and when X answers that the credits have run out it says so on the post.

## 1. Create the app

1. Sign in at <https://console.x.com> (the X Developer Console) with the X
   account that should own the app. It does not have to be an account you
   will post from.
2. Create a project and an app in it, if the console did not already make
   one for you.
3. Add credits under billing. Without credits X refuses every call.

X renames and rearranges this console from time to time. If a label below is
not where this says, look for the same idea nearby; the values to enter do
not change.

## 2. Turn on sign-in for the app

In the app's settings, find **User authentication settings** and set it up:

| Setting                     | Value                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| App permissions             | **Read and write**                                                                                                    |
| Type of App                 | **Web App, Automated App or Bot** (a confidential client)                                                             |
| Callback URI / Redirect URL | The redirect URI BMM shows under **Networks**, X. It looks like `https://<your BMM address>/api/v1/oauth/x/callback`. |
| Website URL                 | Any address you own. X only wants the field filled.                                                                   |

The redirect URI must match character for character. It only has to work in
your own browser, so an address inside your network is fine.

## 3. Copy the credentials into BMM

1. In the app's **Keys and tokens**, find the **OAuth 2.0 Client ID and
   Client Secret**. These are not the "API Key and Secret" shown above them,
   which belong to the older OAuth 1.0a.
2. In BMM, open **Networks**, enter both under X and save. The secret is
   stored encrypted and never shown again.

## 4. Connect an account

1. Open a profile in BMM and press **Connect X account**.
2. X asks you to approve the app. Check that the account shown at X is the
   one you mean to connect: X uses whichever account that browser is signed
   in to.
3. You land back on the profile with the account listed.

To connect a second X account, to this or another profile, sign in to that
account at x.com in the same browser first, then connect again.

## What BMM asks X for

`tweet.read`, `tweet.write`, `users.read`, `media.write` and
`offline.access`. The last one lets BMM renew its access without you; X's
access lasts two hours at a time and BMM renews it when a post is due.

## What works

- Text posts, and posts with up to four images (JPEG, PNG or WebP, up to
  5 MB each), with alt text.
- Not yet: video, GIFs, threads, polls, replies, and reading analytics or
  messages.

## When something goes wrong

| What you see                                | What it means                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Connect the account again" on an account   | X revoked or expired BMM's access: the app was removed from the account, its password changed, or the app's settings changed. Press **Reconnect**. |
| "X answered 402" or a message about credits | The developer account has no credits left. Add some in the console, then **Retry failed** on the post.                                             |
| "X answered 403" with "duplicate content"   | X refuses the same text twice in a row from one account. Change the text.                                                                          |
| "It may or may not have been published"     | X did not answer after BMM sent the post. Look at the account. BMM will not send it again by itself, so that it cannot be posted twice.            |
| The redirect ends on an X error page        | The redirect URI at X does not match the one BMM shows, or the app type is not a web app.                                                          |
