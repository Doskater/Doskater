# Hi, I'm Doskater

I'm building a freelance portfolio focused on AI workflows, web automation, and small business process automation.

## What I build

- Lead capture workflows
- CSV / Excel business reports
- AI-assisted email reply drafts
- Website monitoring tools
- Browser automation with Playwright

## Portfolio projects

### Lead Capture Automation
A Flask app that captures business leads, saves them to CSV, assigns priority, and generates follow-up drafts.  
https://github.com/Doskater/lead-capture-automation

### CSV / Excel Report Generator
A Python automation project that cleans messy sales CSV data and generates an Excel business report.  
https://github.com/Doskater/csv-excel-report-generator

### AI Email Reply Assistant
A Python project that classifies customer emails, assigns priority, and generates professional reply drafts.  
https://github.com/Doskater/ai-email-reply-assistant

### Website Monitor
A Python tool that monitors local website pages and reports content changes.  
https://github.com/Doskater/website-monitor

### Form Auto-Filler with Playwright
A Python Playwright project that automates filling and submitting a local lead form.  
https://github.com/Doskater/form-autofiller-playwright

## Tech stack

Python, Flask, pandas, openpyxl, BeautifulSoup, Playwright, HTML/CSS, CSV/Excel automation.

## Freelance focus

I help small businesses automate repetitive workflows, process data, monitor websites, and build small internal tools.

## Trading pipeline policy

The canonical operating prompt for full trading-pipeline runs is [`PIPELINE_PROMPT.md`](./PIPELINE_PROMPT.md). It explicitly pre-authorizes automatic watcher-level synchronization after a full run while preserving the hard boundary that order/leverage/protection writes require an explicit user instruction.

## ChatGPT Cloud Trading Analyst

This repository also contains a read-only cloud market-data plane for a ChatGPT-driven trading analysis workflow.

Core rule: **ChatGPT is the analytical/computational engine; the cloud service is data infrastructure only.**

See:
- `docs/superpowers/specs/2026-10-14-chatgpt-cloud-trading-analyst-design.md`
- `docs/superpowers/plans/2026-10-14-chatgpt-cloud-trading-analyst-implementation-plan.md`
- `trading-data-plane/README.md`

The public proxy in `public-proxy.js` exposes only the seven read-only Data Plane tools. Trade execution remains outside this service and requires a separate explicit Bybit Demo Execution action.
