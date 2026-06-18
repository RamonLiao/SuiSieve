#[test_only]
module creatorflow::capabilities_tests;

use creatorflow::capabilities;
use sui::test_scenario as ts;
use std::unit_test::{assert_eq, destroy};

const CREATOR: address = @0xC;

// The whole point of this module is the binding invariant: a freshly minted
// Cap reports exactly the ID it was bound to at mint time. If these break,
// the access-control story ("a Cap authorizes exactly one object") is broken.

#[test]
fun owner_cap_binds_config_id() {
    let mut sc = ts::begin(CREATOR);
    let config_id = object::id_from_address(@0x111);
    let cap = capabilities::new_owner_cap(config_id, sc.ctx());
    assert_eq!(capabilities::owner_cap_config_id(&cap), config_id);
    destroy(cap);
    sc.end();
}

#[test]
fun tax_cap_binds_vault_id() {
    let mut sc = ts::begin(CREATOR);
    let vault_id = object::id_from_address(@0x222);
    let cap = capabilities::new_tax_cap(vault_id, sc.ctx());
    assert_eq!(capabilities::tax_cap_vault_id(&cap), vault_id);
    destroy(cap);
    sc.end();
}

#[test]
fun savings_cap_binds_vault_id() {
    let mut sc = ts::begin(CREATOR);
    let vault_id = object::id_from_address(@0x333);
    let cap = capabilities::new_savings_cap(vault_id, sc.ctx());
    assert_eq!(capabilities::savings_cap_vault_id(&cap), vault_id);
    destroy(cap);
    sc.end();
}

// Monkey: minting two caps from the SAME vault_id yields two independent
// objects (distinct UIDs) that both report the same binding — minting does not
// alias or mutate the shared binding, and the binding is per-cap immutable.
#[test]
fun two_caps_same_binding_distinct_objects() {
    let mut sc = ts::begin(CREATOR);
    let vault_id = object::id_from_address(@0x444);
    let cap_a = capabilities::new_tax_cap(vault_id, sc.ctx());
    let cap_b = capabilities::new_tax_cap(vault_id, sc.ctx());

    assert_eq!(capabilities::tax_cap_vault_id(&cap_a), vault_id);
    assert_eq!(capabilities::tax_cap_vault_id(&cap_b), vault_id);
    // distinct object identities despite identical binding
    assert!(object::id(&cap_a) != object::id(&cap_b));

    destroy(cap_a);
    destroy(cap_b);
    sc.end();
}
