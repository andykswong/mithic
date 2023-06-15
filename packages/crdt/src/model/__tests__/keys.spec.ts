import { getEventIndexKey, getFieldNameFromKey, getFieldValueKey, getHeadIndexKey, getPrefixEndKey } from '../keys.js';

describe(getFieldValueKey.name, () => {
  it('should return the correct key', () => {
    expect(getFieldValueKey('map')).toBe('V::map');
    expect(getFieldValueKey('map', 'field')).toBe('V::map:F:field');
    expect(getFieldValueKey('map', 'field', 'eventKey')).toBe('V::map:F:field:E:eventKey');
  });
});

describe(getHeadIndexKey.name, () => {
  it('should return the correct key', () => {
    expect(getHeadIndexKey('map')).toBe('H::map');
    expect(getHeadIndexKey('map', void 0, 'eventKey')).toBe('H::map:E:eventKey');
    expect(getHeadIndexKey('map', 'field')).toBe('H::map:F:field');
    expect(getHeadIndexKey('map', 'field', 'eventKey')).toBe('H::map:F:field:E:eventKey');
  });
});

describe(getEventIndexKey.name, () => {
  it('should return the correct key', () => {
    expect(getEventIndexKey('eventKey')).toBe('E::eventKey');
    expect(getEventIndexKey('eventKey', 'field')).toBe('E::eventKey:F:field');
  });
})

describe(getPrefixEndKey.name, () => {
  it('should return the correct key', () => {
    expect(getPrefixEndKey('H::map')).toBe('H::map\udbff\udfff');
  });
});

describe(getFieldNameFromKey.name, () => {
  it('returns the field name', () => {
    expect(getFieldNameFromKey('H::test:F:foo')).toBe('foo');
    expect(getFieldNameFromKey('V::test:F:foo:E:bar')).toBe('foo');
  });

  it('returns an empty string if the key does not have a field key', () => {
    expect(getFieldNameFromKey('V::foo:bar')).toBe('');
  });
});
