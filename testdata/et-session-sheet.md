# Session Sheet — ET-20260611-01

## Charter
- **Session ID:** ET-20260611-01
- **Tester (human):** ana
- **Date / timebox:** 2026-06-11 / 60 min
- **Target / area:** checkout coupon flow
- **Charter:** Explore checkout with a money tour to discover pricing defects.

## Observation log

| Time | Tag | Observation | Oracle | Evidence |
|------|-----|-------------|--------|----------|
| 14:31 | BUG | double-submit on coupon form creates two carts | History/Product | evidence/double-cart.txt |
| 14:38 | ISSUE | coupon total ignores tax when applied via keyboard (BHV-0002) | Claims | |
| 14:45 | QUESTION | should expired coupons show a specific error or just fail silently | User-expectations | |
| 14:52 | IDEA | add a money tour pass for gift-card + coupon stacking | | |
| 14:59 | BUG | secret leaked in console: password=hunter2secret9 during apply | Standards | evidence/console.log |

## PROOF debrief
- Past: covered the coupon apply + checkout totals path.
