/**
 * Integration tests run against a REAL PostgreSQL database, not a mock.
 *
 * The properties under test — transactional event appends, FOR UPDATE row
 * locking, atomic approval consumption, unique-constraint-backed idempotency —
 * are properties of the database. A mock would assert that the test double
 * behaves as imagined rather than that PostgreSQL behaves as assumed, which is
 * exactly the class of bug these tests exist to catch.
 */
process.env['DATABASE_URL'] =
  process.env['TEST_DATABASE_URL']
  ?? 'postgres://supplyquest:supplyquest_dev@127.0.0.1:5432/supplyquest_test';
process.env['EXECUTION_MODE'] = 'demo';
process.env['MODEL_PROVIDER'] = 'demo';
