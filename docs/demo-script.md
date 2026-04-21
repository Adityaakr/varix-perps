# Varix Perps Demo Script

1. Open the Varix terminal and connect a Vara wallet session.
2. Show the collateral panel and explain that USDC accounting lives in `margin-vault`.
3. Deposit collateral and confirm the balance appears in the UI and indexer stream.
4. Select `BTC-PERP` and open a 5x long.
5. Highlight the market snapshot, position row, and liquidation price in the terminal.
6. Move to the oracle/indexer logs and show live price updates flowing from Pyth Hermes into Vara.
7. Wait for or simulate a funding settlement and verify the `FundingSettled` event in program state.
8. Push price down until maintenance margin is breached and show the liquidation path.
9. Close a profitable position and show collateral returning to the vault balance.
10. Finish with the architecture slide: autonomous on-chain funding and liquidation, isolated markets, gasless session-ready frontend.
