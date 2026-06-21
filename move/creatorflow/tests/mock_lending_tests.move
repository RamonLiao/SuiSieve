#[test_only]
module creatorflow::mock_lending_tests;

use creatorflow::mock_lending::{Self, EAccrualOverflow};
use std::unit_test::assert_eq;

// interest = principal · rate · elapsed_ms / (10000 · 1000)
// 1_000_000 · 5 · 2000 / 10_000_000 = 1000
#[test]
fun accrue_matches_pinned_example() {
    assert_eq!(mock_lending::accrue(1_000_000, 5, 2_000), 1_000);
}

#[test]
fun accrue_zero_elapsed_or_zero_principal_is_zero() {
    assert_eq!(mock_lending::accrue(1_000_000, 5, 0), 0);
    assert_eq!(mock_lending::accrue(0, 5, 2_000), 0);
}

#[test]
fun accrue_is_linear() {
    let a = mock_lending::accrue(1_000_000, 5, 2_000);
    assert_eq!(mock_lending::accrue(1_000_000, 5, 4_000), a * 2);
    assert_eq!(mock_lending::accrue(2_000_000, 5, 2_000), a * 2);
}

// u64::MAX principal with a small elapsed must NOT overflow u128 and result fits u64.
#[test]
fun accrue_no_u128_overflow_at_max_principal_bounded() {
    // principal=u64::MAX, rate=5, elapsed=1 ms:
    // product = 1.84e19 · 5 · 1 = 9.2e19 << u128 max (3.4e38).
    // result  = 9.2e19 / 1e7 = 9.2e12 << u64::MAX — computes, no abort.
    let _ = mock_lending::accrue(18_446_744_073_709_551_615, 5, 1);
}

// A result that exceeds u64 range must fail loud, not silently truncate.
#[test, expected_failure(abort_code = EAccrualOverflow)]
fun accrue_overflow_fails_loud() {
    // principal=u64::MAX, rate=5, elapsed=3_000_000 ms:
    // product = 1.84e19 · 5 · 3e6 = 2.76e26 << u128 max — no u128 overflow.
    // result  = 2.76e26 / 1e7 = 2.76e19 >> u64::MAX → EAccrualOverflow.
    let _ = mock_lending::accrue(18_446_744_073_709_551_615, 5, 3_000_000);
}
