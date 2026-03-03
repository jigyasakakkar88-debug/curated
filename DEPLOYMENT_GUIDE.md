# CURATED — Deployment Guide
### Your personal style aggregator, step by step

---

## What you're deploying

| File | What it does |
|------|-------------|
| `public/index.html` | Your style feed — the main site you browse |
| `public/admin.html` | Admin panel to add/remove brands |
| `api/products.js` | Fetches live products from your Shopify brands |
| `api/admin.js` | Powers the admin panel |
| `api/refresh.js` | Runs weekly to refresh your feed |

---

## Step 1 — Create a free GitHub account (5 min)

1. Go to **https://github.com** and click **Sign up**
2. Use any email, pick a username, verify your account
3. You're done — you just need this to store your code

---

## Step 2 — Upload your project to GitHub (5 min)

1. On GitHub, click the **+** icon (top right) → **New repository**
2. Name it `style-aggregator`
3. Make sure it's set to **Private** (so only you see it)
4. Click **Create repository**
5. On the next page, click **uploading an existing file**
6. Drag ALL the files/folders from this zip into the upload area:
   - The `api` folder (with its 3 .js files inside)
   - The `public` folder (with index.html and admin.html inside)
   - `vercel.json`
   - `package.json`
7. Click **Commit changes**

---

## Step 3 — Create a free Vercel account (3 min)

1. Go to **https://vercel.com** and click **Sign Up**
2. Choose **Continue with GitHub** — this links the two together
3. Authorize Vercel to access your GitHub

---

## Step 4 — Deploy your site on Vercel (5 min)

1. On Vercel dashboard, click **Add New → Project**
2. Find `style-aggregator` in the list and click **Import**
3. Leave all settings as-is — Vercel will detect everything automatically
4. Click **Deploy**
5. Wait ~1 minute while it builds
6. 🎉 You'll see a green success screen with your site URL (something like `style-aggregator-abc123.vercel.app`)

---

## Step 5 — Set your admin password (3 min)

Right now the admin password is `changeme123`. Here's how to set your own:

1. In Vercel, go to your project → **Settings** → **Environment Variables**
2. Click **Add New**
3. Set:
   - **Key:** `ADMIN_PASSWORD`
   - **Value:** (choose any password you want)
4. Click **Save**
5. Go to **Deployments** and click **Redeploy** to apply the change

---

## Step 6 — Open your site!

- **Your style feed:** `https://your-site.vercel.app`
- **Admin panel:** `https://your-site.vercel.app/admin`

Your site already has **Ganga Fashions** and **Khara Kapas** pre-loaded. It will fetch their real live products automatically.

---

## Adding more brands (anytime)

1. Go to `https://your-site.vercel.app/admin`
2. Enter your admin password
3. Type the brand name and their website URL
4. Click **Test URL** — it will confirm if it's a Shopify store
5. Click **Add Brand**
6. You'll see a yellow box with a value to copy
7. Go to Vercel → Settings → Environment Variables
8. Add/update `BRANDS_JSON` with that copied value
9. Redeploy

---

## How the weekly refresh works

Vercel will automatically run your refresh every **Monday at 6am UTC** — that's 11:30am IST. You don't need to do anything.

You can also manually refresh anytime from the Admin panel → **Refresh Feed**.

---

## Troubleshooting

**"Products not loading" on the site**
- Open your browser's developer tools (F12) → Console tab
- Look for any red error messages and note them
- Most common fix: make sure your Vercel deployment succeeded (no red X in Vercel dashboard)

**"Unauthorized" in admin panel**
- Double-check your `ADMIN_PASSWORD` environment variable in Vercel
- Make sure you redeployed after setting it

**A brand shows 0 products**
- That brand's store may have changed its setup
- Go to Admin → remove and re-add the brand
- Use the **Test URL** button to verify it's still a valid Shopify store

**Want to use a custom domain (e.g. mystyle.com)?**
- Buy a domain from Namecheap or GoDaddy (~$10/year)
- In Vercel → Settings → Domains → Add your domain
- Follow their simple DNS setup instructions

---

## Costs

Everything here is **free**:
- GitHub: Free for private repos
- Vercel: Free tier covers this easily (100GB bandwidth/month, generous function calls)
- No database, no server costs

The only potential cost is a custom domain if you want one (~$10/year, optional).

---

*Built with Shopify's public products.json API · Hosted on Vercel · Refreshes every Monday*
