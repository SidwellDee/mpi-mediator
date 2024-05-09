import { Bundle } from 'fhir/r3';
import { getConfig } from '../../config/config';
import {
  buildOpenhimResponseObject,
  getData,
  isHttpStatusOk,
  mergeBundles,
} from '../../utils/utils';
import logger from '../../logger';
import { MpiMediatorResponseObject } from '../../types/response';

const {
  fhirDatastoreProtocol: protocol,
  fhirDatastoreHost: host,
  fhirDatastorePort: port,
} = getConfig();

export const fetchAllPatientSummariesByRefs = async (
  patientRefs: string[],
  queryParams?: object
): Promise<Bundle> => {
  // remove duplicates
  patientRefs = Array.from(new Set(patientRefs.map(ref => ref?.split('/').pop() || '')));

  const patientExternalRefs = patientRefs.map((ref) => {
    const params = Object.entries(queryParams ?? {});
    let combinedParams = null;

    if (params.length > 0) {
      combinedParams = params
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join('&');
    }

    const path = `/fhir/Patient/${ref}/$summary${combinedParams ? `?${combinedParams}` : ''}`;

    return getData(protocol, host, port, path, {
      'Content-Type': 'application/fhir+json',
    }).then((response) => {
      if (!isHttpStatusOk(response.status) && response.status != 404) {
        // We throw an error if one of the requests fails ( except for cases where a patient link does not exist in the datastore)
        throw response;
      }

      return response;
    });
  });

  const bundles = (await Promise.all(patientExternalRefs))
    .filter((res) => isHttpStatusOk(res.status))
    .map((response) => response?.body as Bundle);

  logger.debug(`Fetched all patient summaries from the MPI: ${bundles}`);

  return mergeBundles(bundles, 'document');
};

export const fetchPatientSummaryByRef = async (
  ref: string,
  queryParams: object
): Promise<MpiMediatorResponseObject> => {
  try {
    const bundle = await fetchAllPatientSummariesByRefs([ref], queryParams);
    const responseBody = buildOpenhimResponseObject('Successful', 200, bundle);

    logger.info(`Successfully fetched patient summary with id ${ref}`);

    return {
      status: 200,
      body: responseBody,
    };
  } catch (err) {
    logger.error(`Unable to fetch patient resources for id ${ref}`, err);

    const status = (err as any).status || 500;
    const body = (err as any).body || {};

    return {
      body: buildOpenhimResponseObject('Failed', status, body),
      status: status,
    };
  }
};
