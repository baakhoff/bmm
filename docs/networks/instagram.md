# Connecting Instagram

BMM publishes to Instagram through Meta's official Instagram API, with an
app that you own. Publishing through it is free.

## Before you start

- **The Instagram account must be a professional one**: Business or
  Creator. Switching is free and takes a minute in the Instagram app:
  Settings, Account type and tools, Switch to professional account. A
  personal account cannot be published to by any tool.
- **You need a public media address.** Instagram does not accept image
  uploads; it downloads each image from a public https address. Set that up
  first: [public media](../public-media.md). Without it BMM can connect the
  account but not publish.
- **BMM itself must be opened over https.** Meta only redirects back to
  https addresses. The address does not have to be reachable from the
  internet; a valid certificate on your internal name is enough.

## 1. Create the app

1. Sign in at <https://developers.facebook.com> and register as a developer
   if asked.
2. **My Apps**, **Create App**. Give it a name; choose the use case or type
   that lets you manage Instagram content. If asked for a business
   portfolio, you can skip it for an app you only use yourself.
3. In the app's dashboard, add the **Instagram** product and choose
   **API setup with Instagram login**. This is the variant that needs no
   Facebook Page.

Meta rearranges this dashboard often. If a label below is not where this
says, look for the same idea nearby; the values to enter do not change.

## 2. Configure sign-in

Under **Instagram**, **API setup with Instagram login**, find the business
login settings and add the redirect URI BMM shows under **Networks**,
Instagram. It looks like:

```
https://<your BMM address>/api/v1/oauth/instagram/callback
```

It must match character for character.

## 3. Let your own account use the app

A new app is in development mode. In that mode it works only for accounts
that have a role on it, which is exactly what a personal instance needs, and
it needs no review by Meta.

1. In the app, open **App roles**, **Roles** and add each Instagram account
   you want to connect as an **Instagram Tester**.
2. Accept the invitation from that Instagram account: on instagram.com,
   Settings, **Apps and websites**, **Tester invites**.

You only need Meta's app review, and to switch the app to live mode, if
people other than you will connect their accounts.

## 4. Copy the credentials into BMM

1. On the same **API setup with Instagram login** page, copy the
   **Instagram app ID** and **Instagram app secret**. These are not the
   app's main App ID and App Secret under Settings, Basic.
2. In BMM, open **Networks**, enter both under Instagram and save. The
   secret is stored encrypted and never shown again.

## 5. Connect an account

1. Open a profile in BMM and press **Connect Instagram account**.
2. Instagram asks you to approve. Check that the account shown is the one
   you mean: it is whichever account that browser is signed in to.
3. You land back on the profile with the account listed.

## What BMM asks Instagram for

`instagram_business_basic` and `instagram_business_content_publish`.
Instagram's access lasts 60 days and can be extended; BMM extends it weekly
whenever a post goes out. An account that publishes nothing for two months
has to be connected again.

## What works

- A single image, or a carousel of up to ten, with a caption and alt text.
  PNG and WebP are converted to JPEG, which is all Instagram takes.
- Images must be between 4:5 (portrait) and 1.91:1 (landscape). BMM checks
  this before you schedule.
- Not yet: Reels and other video, Stories, and reading analytics, comments
  or messages. Text without an image is not possible on Instagram at all.

## When something goes wrong

| What you see                                | What it means                                                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "This instance has no public media address" | Set up [public media](../public-media.md).                                                                                                                  |
| "Instagram could not process the image"     | Instagram could not download it. Open the public media address from outside your network; see the checks in [public media](../public-media.md#checking-it). |
| "Insufficient developer role" at Instagram  | The account is not a tester on the app, or has not accepted the invitation. Step 3.                                                                         |
| "Invalid redirect_uri" at Instagram         | The redirect URI in the app does not match the one BMM shows, or BMM is not on https.                                                                       |
| "Connect the account again" on an account   | Access expired or was removed. Press **Reconnect**.                                                                                                         |
| "It may or may not have been published"     | Instagram did not answer after BMM asked it to publish. Look at the account. BMM will not send it again by itself.                                          |
