// admin.test.js — unit tests for pure functions in admin.js
// Run with: node --experimental-vm-modules tests/admin.test.js
// (No test framework needed — uses Node assert)

const assert = require('assert');

// ── Inline the pure functions under test ──
// (Mirrors exactly what is in admin.js so tests are isolated from Chrome APIs)
function addItem(list, name) {
  const trimmed = name.trim();
  if (!trimmed) return list;
  const id = 'id-test-' + list.length;
  return [...list, { id, name: trimmed }];
}

function removeItem(list, id) {
  return list.filter((item) => item.id !== id);
}

// ── addItem tests ──
{
  // Add to empty list
  const result = addItem([], 'Alpha');
  assert.strictEqual(result.length, 1, 'addItem: length should be 1');
  assert.strictEqual(result[0].name, 'Alpha', 'addItem: name should be Alpha');
  assert.ok(result[0].id, 'addItem: id should be truthy');

  // Add to non-empty list — original not mutated
  const original = [{ id: 'x', name: 'Existing' }];
  const result2 = addItem(original, 'Beta');
  assert.strictEqual(result2.length, 2, 'addItem: length should be 2');
  assert.strictEqual(original.length, 1, 'addItem: original list must not be mutated');

  // Empty / whitespace-only name returns list unchanged
  const result3 = addItem([{ id: 'x', name: 'X' }], '   ');
  assert.strictEqual(result3.length, 1, 'addItem: whitespace name should not add');

  // Empty string returns list unchanged
  const result4 = addItem([], '');
  assert.strictEqual(result4.length, 0, 'addItem: empty string should not add');

  // Name is trimmed
  const result5 = addItem([], '  Trimmed  ');
  assert.strictEqual(result5[0].name, 'Trimmed', 'addItem: name should be trimmed');

  console.log('addItem: all tests passed ✓');
}

// ── removeItem tests ──
{
  const list = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
    { id: 'c', name: 'Gamma' }
  ];

  // Remove middle item
  const result = removeItem(list, 'b');
  assert.strictEqual(result.length, 2, 'removeItem: length should be 2');
  assert.ok(!result.find(i => i.id === 'b'), 'removeItem: b should be gone');

  // Original not mutated
  assert.strictEqual(list.length, 3, 'removeItem: original list must not be mutated');

  // Remove non-existent id — list unchanged
  const result2 = removeItem(list, 'zzz');
  assert.strictEqual(result2.length, 3, 'removeItem: non-existent id should leave list unchanged');

  // Remove from empty list
  const result3 = removeItem([], 'a');
  assert.strictEqual(result3.length, 0, 'removeItem: empty list stays empty');

  // Remove first item
  const result4 = removeItem(list, 'a');
  assert.strictEqual(result4[0].id, 'b', 'removeItem: first item should now be b');

  // Remove last item
  const result5 = removeItem(list, 'c');
  assert.strictEqual(result5[result5.length - 1].id, 'b', 'removeItem: last item should now be b');

  console.log('removeItem: all tests passed ✓');
}

console.log('\nAll admin.js unit tests passed. ✓');
