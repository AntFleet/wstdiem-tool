# Operator Monitoring

Use the monitor command for a one-shot live dashboard of wstDIEM vault supply/assets, Curve liquidity, Morpho liquidity, deployed executor status, owner position, and Morpho authorization.

```sh
export BASE_RPC_URL="https://mainnet.base.org"
npm run build
npm run monitor:live
```

Optional owner and executor overrides:

```sh
node dist/cli/index.js monitor \
  --owner "0x..." \
  --loop-executor "0x..."
```

To emit monitor alerts to configured stderr, webhooks, and Telegram:

```sh
node dist/cli/index.js monitor --alert
```

Telegram config is read from `config.yaml`:

```yaml
alerts:
  telegram:
    botTokenEnv: WSTDIEM_TELEGRAM_BOT_TOKEN
    chatId: "123456789"
```

Then set the token in the environment:

```sh
export WSTDIEM_TELEGRAM_BOT_TOKEN="..."
```

The vault row tracks the configured wstDIEM vault:

- vault / wstDIEM: `0xe49FA849cB37b0e7A42B2335e333fb99474167ba`
- asset / DIEM: `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024`
- total wstDIEM supply
- total DIEM assets
- `convertToAssets(1 wstDIEM)` NAV

Monitor alerts intentionally ignore the closed production audit gate. They alert on actionable live-state blockers only: unavailable RPC, missing or unhealthy wstDIEM vault, empty Curve liquidity, empty Morpho supply, missing/no-code/mismatched executor, missing owner position, and missing Morpho executor authorization.
