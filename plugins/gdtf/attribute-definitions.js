import importJson from '../../lib/import-json.js';

/**
 * @typedef {object} GdtfAttributeDefinition
 * @property {string} name The attribute name, may contain `(n)` and `(m)` placeholders.
 * @property {string} pretty The pretty name, may contain the same placeholders.
 * @property {string} feature Feature group and feature, separated by a dot.
 * @property {string} [physicalUnit] The physical unit, `None` if not given.
 * @property {string} [activationGroup] The activation group, may contain placeholders.
 * @property {string} [mainAttribute] The main attribute, may contain placeholders.
 * @property {string} [color] Default color in CIE 1931 xyY.
 */

/**
 * @typedef {object} ResolvedAttributeDefinition
 * @property {string} name The concrete attribute name.
 * @property {string} pretty The concrete pretty name.
 * @property {string} feature Feature group and feature, separated by a dot.
 * @property {string} physicalUnit The physical unit.
 * @property {string | undefined} activationGroup The concrete activation group.
 * @property {string | undefined} mainAttribute The concrete main attribute.
 * @property {string | undefined} color Default color in CIE 1931 xyY.
 */

/** @type {GdtfAttributeDefinition[]} */
const definitions = await importJson('./gdtf-attribute-definitions.json', import.meta.url);

/**
 * Corrections of obvious errors in the official attribute definitions.
 * @type {Record<string, Partial<GdtfAttributeDefinition>>}
 */
const errata = {
  // "Controls angle of indexed rotation of prisms", but its physical unit is given as AngularSpeed
  'Prism(n)Pos': { physicalUnit: 'Angle' },
};

for (const definition of definitions) {
  Object.assign(definition, errata[definition.name]);
}

const PLACEHOLDER_REGEX = /\([mn]\)/g;

const matchers = definitions.map((definition) => {
  const placeholders = definition.name.match(PLACEHOLDER_REGEX) ?? [];
  const pattern = definition.name
    .split(PLACEHOLDER_REGEX)
    .map((part) => part.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`))
    .join(String.raw`(\d+)`);
  return {
    definition,
    placeholders: placeholders.map((placeholder) => placeholder[1]),
    regex: new RegExp(`^${pattern}$`),
  };
});

/**
 * @param {string} attributeName - A concrete GDTF attribute name, like `Gobo2WheelSpin`.
 * @returns {ResolvedAttributeDefinition | null} The definition with resolved placeholders, or null if the attribute is not defined in the GDTF standard.
 */
export function getAttributeDefinition(attributeName) {
  for (const { definition, placeholders, regex } of matchers) {
    const match = attributeName.match(regex);
    if (!match) {
      continue;
    }

    const indices = Object.fromEntries(placeholders.map((placeholder, index) => [placeholder, match[index + 1]]));
    const resolve = (string) => string?.replaceAll(PLACEHOLDER_REGEX, (placeholder) => indices[placeholder[1]] ?? placeholder);

    return {
      name: attributeName,
      pretty: resolve(definition.pretty),
      feature: definition.feature,
      physicalUnit: definition.physicalUnit ?? 'None',
      activationGroup: resolve(definition.activationGroup),
      mainAttribute: resolve(definition.mainAttribute),
      color: definition.color,
    };
  }

  return null;
}

/**
 * @param {string} attributeName - A concrete GDTF attribute name.
 * @returns {boolean} Whether the attribute is defined in the GDTF standard.
 */
export function isStandardAttribute(attributeName) {
  return getAttributeDefinition(attributeName) !== null;
}
