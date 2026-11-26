import https from 'https';
import JSZip from 'jszip';
import { XmlDocument, XsdValidator } from 'libxml2-wasm';

const SCHEMA_URL = 'https://raw.githubusercontent.com/mvrdevelopment/tools/main/gdtf.xsd';

/** @type {Promise<string> | undefined} */
let schemaPromise;

/**
 * @param {object} exportFile - The file returned by the plugins' export module.
 * @param {string} exportFile.name - File name, may include slashes to provide a folder structure.
 * @param {Buffer} exportFile.content - File content (a GDTF zip archive).
 * @param {string} exportFile.mimetype - File mime type.
 * @param {Fixture[] | null} exportFile.fixtures - Fixture objects that are described in given file.
 * @param {string | null} exportFile.mode - Mode's shortName if given file only describes a single mode.
 * @returns {Promise<void, string[] | string>} Resolve when the test passes or reject with an array of errors or one error if the test fails.
 */
export default async function testSchemaConformity(exportFile) {
  schemaPromise ??= fetchSchema();
  const schemaData = await schemaPromise;

  const zip = await JSZip.loadAsync(exportFile.content);
  const descriptionFile = zip.file('description.xml');
  if (!descriptionFile) {
    throw 'GDTF archive does not contain description.xml';
  }

  const xsdDocument = XmlDocument.fromString(schemaData);
  const validator = XsdValidator.fromDoc(xsdDocument);
  const xmlDocument = XmlDocument.fromString(await descriptionFile.async('string'));

  try {
    validator.validate(xmlDocument);
  }
  catch (error) {
    throw error.details?.map((detail) => detail.message) ?? error.message;
  }
  finally {
    validator.dispose();
    xsdDocument.dispose();
    xmlDocument.dispose();
  }
}

/**
 * @returns {Promise<string>} The GDTF XSD schema.
 */
function fetchSchema() {
  return new Promise((resolve, reject) => {
    https.get(SCHEMA_URL, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => resolve(data));
    }).on('error', (error) => reject(`Failed fetching GDTF XSD schema: ${error.message}`));
  });
}
