export function testAccess<
  Value extends object,
  Fixture extends object = object
>(value: Fixture): Value {
  // SAFETY: Tests use this adapter only for fixture members that they install.
  return Object(value) as Value
}
