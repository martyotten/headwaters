# Private CRM setup (one time)

The CRM at `/crm/` keeps its data in a Supabase database, never in this repo.

1. **Create the project.** Sign up at supabase.com, then click *New project*. Pick a region near Minnesota (for example, US East) and save the database password somewhere safe.
2. **Create the tables.** Open *SQL Editor*, click *New query*, paste in all of `setup.sql`, and click *Run*.
3. **Lock down sign-in.** Under *Authentication*:
   - *Sign In / Providers*: keep **Email** on, and turn **Allow new users to sign up** off.
   - *Users*: click *Add user*, then *Create new user*, and enter your own email. You will be the only user.
   - *URL Configuration*: set **Site URL** to `https://headwatersadvisorymn.com/crm/` and add the same address under **Redirect URLs**. To sign in on Netlify deploy previews, also add `https://*--headwaters-advisory.netlify.app/crm/`. A link to an address that isn't listed falls back to the Site URL.
4. **Connect the page.** Under *Project Settings*, then *API Keys*, copy the **Project URL** and the **Publishable** key (or the legacy `anon` key) into `crm/config.js`. These two values are safe to make public. Never use the **Secret** or `service_role` key; the tests reject it.

On the free plan, Supabase pauses a project after about a week with no use. Your data is kept; click *Restore* on the dashboard to wake it.
