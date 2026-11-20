# WeBringo 💬

Conversation bingo for friends, parties and social gatherings. Everyone fills a bingo card with topics they expect to hear, then listens out as the conversation goes on. Each time a topic comes up, tap its box for +1. Repeat mentions count too. The first bingo ends the game, and the leaderboard shows who scored the most.

## How a game works

1. **Create a room.** Choose a card size (3×3, 4×4 or 5×5) and a bingo rule:
   - **Line:** any full row, column or diagonal
   - **Full card:** every box
   You can still change these in the lobby before the game starts (tap **Change**).
2. **Invite friends** with the 4‑letter room code, the QR code or **Share invite link**.
3. **Fill your card.** Type one word or phrase in each box. You can't use the same phrase twice: duplicates are highlighted in red, and capitals or extra spaces don't make a phrase different. **I'm ready** switches on once every box is filled. Tap it again if you want to edit your card.
4. The host's **Start game** button switches on once **everyone** in the room is ready.
5. **Play.** When you hear a topic, tap its box. Every tap is +1 point, so tap again each time it comes up. **Undo** removes your last tap.
6. **The game ends** as soon as someone gets a bingo. The host can also end it at any time with **End game** (tap twice to confirm).
7. **Leaderboard:** players are ranked by points, the bingo winner is tagged, and the winning card is shown. The host taps **Play again** to go back to the lobby, where everyone's last card is kept so they can edit it or just tap ready.

## Try it right now (no setup)

Open `index.html` through any local web server (or the GitHub Pages site before Firebase is set up). A yellow **Local demo mode** bar appears. Open a few tabs in the same browser and each tab acts as a different player.

## Put it online so friends can play from their phones

You need two free things: a **Firebase** project (keeps everyone in sync) and **GitHub Pages** (hosts the website).

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> and click **Create a project** (any name, e.g. `webringo`). You can turn Google Analytics off.

### 2. Turn on anonymous sign‑in
1. In the left menu: **Build → Authentication → Get started**.
2. On the **Sign‑in method** tab, choose **Anonymous**, switch it **on** and click **Save**.

### 3. Create the database
1. **Build → Realtime Database → Create database**.
2. Pick a location near you (e.g. Belgium `europe-west1` for the UK).
3. Choose **Start in locked mode** and click **Enable**.

### 4. Add the rules
1. On the Realtime Database page, open the **Rules** tab.
2. Delete everything there and paste in the whole contents of `database.rules.json` from this folder.
3. Click **Publish**.

### 5. Connect the website to Firebase
1. Click the ⚙️ gear next to **Project Overview → Project settings**.
2. Under **Your apps**, click the **</>** (Web) icon, give it a nickname and click **Register app**. You don't need Firebase Hosting.
3. Choose **Use a `<script>` tag**. You'll see a block like `const firebaseConfig = { apiKey: "...", ... }`.
4. Open `js/firebase-config.js` and replace the placeholder values with yours. Keep the word **`export`** at the start.
5. Check that there is a **`databaseURL`** line. If it's missing, copy the URL shown at the top of the Realtime Database page (it looks like `https://webringo-default-rtdb.europe-west1.firebasedatabase.app`).

### 6. Allow your website's address
1. **Authentication → Settings → Authorized domains → Add domain**.
2. Add `YOUR-GITHUB-USERNAME.github.io`.

### 7. Publish on GitHub Pages
1. Create a new repository on GitHub (e.g. `WeBringo`) and upload all the files in this folder, keeping the folders (`css`, `js`) and the hidden `.nojekyll` file.
2. In the repository, go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, then **main** and **/ (root)**, and click **Save**.
3. After a minute or two your game is live at `https://YOUR-GITHUB-USERNAME.github.io/WeBringo/`.

## Troubleshooting

- **A yellow "Local demo mode" bar shows on the live site.** The site isn't using your Firebase config yet. Check that `js/firebase-config.js` has your real values, is committed and has been deployed. Then reload.
- **An invite link has `&local` at the end.** It was made while the site was still in demo mode. Go back to the lobby and share a fresh link.
- **"Couldn't connect to the game server".** Check step 2 (Anonymous sign‑in is on) and step 6 (your github.io domain is authorised).
- **Someone closed their phone mid‑game.** Their score is kept. Re‑open the link and tap **Join the game** to carry on.
- **The host left.** If the host is away for more than a minute, the next player who joined takes over as host automatically.

## Files

| File | What it does |
|---|---|
| `index.html` | All the screens |
| `css/style.css` | The glass look |
| `js/main.js` | Game flow: rooms, cards, scoring, leaderboard |
| `js/bingo.js` | Duplicate check and bingo detection |
| `js/backend-firebase.js` | Live sync through Firebase |
| `js/backend-local.js` | Demo mode across tabs (no setup) |
| `js/firebase-config.js` | **Your** Firebase settings |
| `database.rules.json` | Security rules to paste into Firebase |

When you get an updated version later, copy over everything **except** `js/firebase-config.js`, so you keep your settings.
