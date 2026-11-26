#!/usr/bin/env node

import { writeFile } from 'fs/promises';
import https from 'https';
import { fileURLToPath } from 'url';

const SOURCE_URL = 'https://raw.githubusercontent.com/mvrdevelopment/spec/main/gdtf_attributes_with_description.json';
const OUTPUT_FILE = fileURLToPath(new URL('../plugins/gdtf/gdtf-attribute-definitions.json', import.meta.url));

const json = JSON.parse(await fetchText(SOURCE_URL));

/**
 * Trimmed attribute data, see the `GdtfAttributeDefinition` typedef in plugins/gdtf/attribute-definitions.js.
 */
const definitions = json.Attribute.map((attribute) => {
  const definition = {
    name: attribute._name,
    pretty: attribute._prettyName,
    feature: attribute._feature,
  };
  if (attribute._physicalUnit) {
    definition.physicalUnit = attribute._physicalUnit;
  }
  if (attribute._ActivationGroup) {
    definition.activationGroup = attribute._ActivationGroup;
  }
  if (attribute._MainAttribute) {
    definition.mainAttribute = attribute._MainAttribute;
  }
  if (attribute._Color) {
    definition.color = attribute._Color;
  }
  return definition;
});

const fileContent = `${JSON.stringify(definitions, null, 2)}\n`;

await writeFile(OUTPUT_FILE, fileContent);
console.log(`Wrote ${definitions.length} GDTF attribute definitions to ${OUTPUT_FILE}.`);

/**
 * @param {string} url - The URL to fetch.
 * @returns {Promise<string>} The response body.
 */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Fetching ${url} failed with status ${response.statusCode}.`));
        return;
      }
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => resolve(data));
    }).on('error', reject);
  });
}
