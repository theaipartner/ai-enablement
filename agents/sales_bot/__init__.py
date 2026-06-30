"""Sales bot — a Slack agent that answers natural-language questions about
sales data by writing read-only text-to-SQL over the raw schema.

Entry point: `agents.sales_bot.agent.handle_question`. Wired from
`api/slack_events.py` on `app_mention` in the SALES_BOT_SLACK_CHANNEL.
See docs/agents/sales_bot.md and docs/sales/sales-bot-build-plan.md.
"""
