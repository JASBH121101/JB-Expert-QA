# Run a website audit from GitHub

This workflow lets you run JB Expert QA from a browser without installing Node.js on your computer.

## Steps

1. Open the private repository **JB-Expert-QA**.
2. Select **Actions**.
3. Choose **Website audit** in the left sidebar.
4. Click **Run workflow**.
5. Enter the website URL, choose a viewport profile, and select the report format.
6. Open the completed run and download the **jb-expert-qa-report** artifact.

## Inputs

- **Target URL:** a website reachable from GitHub-hosted runners. Use an HTTP or HTTPS URL.
- **Viewport profile:** matrix (mobile, tablet, desktop), desktop, or mobile.
- **Report format:** HTML, Markdown, or JSON.

The HTML report can be opened directly in a browser. Reports are retained by GitHub Actions for seven days in this workflow.

## Important limitations

- This workflow audits websites reachable from GitHub's hosted runner. It cannot reach a development server running only on your work computer.
- Sites protected by authentication are not supported by default. Do not put passwords, session cookies, or tokens in the URL. Sensitive query parameters and URL fragments are redacted in generated reports.
- Remote audits block private, loopback, link-local, and reserved destinations for HTTP(S) resources and WebSocket connections. Service workers are disabled so they cannot bypass request routing.
- Only submit websites you own or are authorized to test.
- If the audit finds issues, the report is still uploaded; the workflow is marked as failed so the findings are visible.
