import { Bundle } from 'fhir/r3';
import format from 'date-fns/format';

import { getConfig } from '../../config/config';
import logger from '../../logger';
import { MpiMediatorResponseObject, Orchestration } from '../../types/response';
import { getMpiAuthToken } from '../../utils/mpi';
import {
  getData,
  isHttpStatusOk,
  createNewPatientRef,
  patientProjector,
  createHandlerResponseObject,
  createClientRegistryOrcherstation,
  createFhirDatastoreOrcherstation,
} from '../../utils/utils';
import { Patient } from 'fhir/r3';

const {
  fhirDatastoreProtocol: fhirProtocol,
  fhirDatastoreHost: fhirHost,
  fhirDatastorePort: fhirPort,
  mpiProtocol,
  mpiHost,
  mpiPort,
  mpiAuthEnabled,
} = getConfig();

const headers: HeadersInit = {
  'Content-Type': 'application/fhir+json',
};

export const fetchPatientByQuery = async (
  query: object
): Promise<MpiMediatorResponseObject> => {
  const combinedParams = new URLSearchParams(query as Record<string, string>).toString();

  const orchestrations: Orchestration[] = [];

  if (mpiAuthEnabled) {
    const token = await getMpiAuthToken();

    headers['Authorization'] = `Bearer ${token.accessToken}`;
  }

  const path = `/fhir/Patient?${combinedParams}`;

  orchestrations.push(createClientRegistryOrcherstation('Match by query', path));

  const mpiResponse = await getData(
    mpiProtocol,
    mpiHost,
    mpiPort,
    `/fhir/Patient?${combinedParams}`,
    headers
  );

  orchestrations[0].response.status = mpiResponse.status;
  orchestrations[0].response.body = JSON.stringify(mpiResponse.body);
  orchestrations[0].response.timestamp = format(new Date(), "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");

  const promises: any[] = [];

  if (isHttpStatusOk(mpiResponse.status)) {
    const bundle = mpiResponse.body as Bundle;

    logger.debug(`Adding patient link FHIR store`);

    addPatientLinks(promises, bundle, orchestrations);
  } else {
    return createHandlerResponseObject('Failed', mpiResponse, orchestrations);
  }

  try {
    const entries = await Promise.all(promises);

    return createHandlerResponseObject(
      'Successful',
      {
        status: 200,
        body: {
          resourceType: 'Bundle',
          id: combinedParams,
          type: 'searchset',
          total: entries.length,
          entry: entries,
        },
      },
      orchestrations
    );
  } catch (err) {
    const status = (err as any).status || 500;
    const body = (err as any).body || {};

    logger.error('Failed to retrieve patient ', body);

    return createHandlerResponseObject('Failed', { status, body }, orchestrations);
  }
};

export const fetchPatientById = async (
  requestedId: string,
  projection: string
): Promise<MpiMediatorResponseObject> => {
  const headers: HeadersInit = {
    'Content-Type': 'application/fhir+json',
  };
  const orchestrations: Orchestration[] = [];
  let path: string = `/fhir/Patient/${requestedId}`;

  orchestrations.push(createFhirDatastoreOrcherstation('Get gutted patient', path));

  const fhirResponse = await getData(fhirProtocol, fhirHost, fhirPort, path, headers);

  orchestrations[0].response.status = fhirResponse.status;
  orchestrations[0].response.body = JSON.stringify(fhirResponse.body);
  orchestrations[0].response.timestamp = format(new Date(), "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");

  let upstreamId = requestedId;

  if (fhirResponse.status === 200) {
    const patient = fhirResponse.body as Patient;
    const interactionId =
      patient.link && patient.link[0]?.other.reference?.match(/Patient\/([^/]+)/)?.[1];

    if (interactionId) {
      upstreamId = interactionId;
      logger.debug(`Swapping source ID ${requestedId} for interaction ID ${upstreamId}`);
    }
  } else {
    return createHandlerResponseObject('Failed', fhirResponse, orchestrations);
  }

  logger.debug(`Fetching patient ${upstreamId} from MPI`);

  if (mpiAuthEnabled) {
    const token = await getMpiAuthToken();

    headers['Authorization'] = `Bearer ${token.accessToken}`;
  }

  path = `/fhir/links/Patient/${upstreamId}`;
  orchestrations.push(createClientRegistryOrcherstation('Get full patient', path));

  const mpiResponse = await getData(mpiProtocol, mpiHost, mpiPort, path, headers);

  orchestrations[1].response.status = mpiResponse.status;
  orchestrations[1].response.body = JSON.stringify(mpiResponse.body);
  orchestrations[1].response.timestamp = format(new Date(), "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");

  let transactionStatus = 'Successful';

  // Map the upstreamId to the requestedId
  if (mpiResponse.status === 200) {
    const patient = mpiResponse.body as Patient;

    patient.id = requestedId;

    if (projection === 'partial') mpiResponse.body = patientProjector(patient);

    logger.debug(
      `Mapped upstream ID ${upstreamId} to requested ID ${requestedId} in response body`
    );
  } else {
    transactionStatus = 'Failed';
  }

  return createHandlerResponseObject(transactionStatus, mpiResponse, orchestrations);
};

const addPatientLinks = (
  promises: any[],
  bundle: Bundle,
  orchestrations: Orchestration[]
): void => {
  bundle.entry?.forEach((patient, index) => {
    const path = `/fhir/Patient/${encodeURIComponent(patient.resource?.id || '')}`;

    const promise = new Promise(async (resolve, reject) => {
      const orchestration: Orchestration = createClientRegistryOrcherstation('adding patient links', path);

      const mpiLinksResponse = await getData(mpiProtocol, mpiHost, mpiPort, path, {});

      orchestration.response.status = mpiLinksResponse.status;
      orchestration.response.body = JSON.stringify(mpiLinksResponse.body);
      orchestration.response.timestamp = format(new Date(), "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
      orchestrations.push(orchestration);

      if (isHttpStatusOk(mpiLinksResponse.status)) {
        const patient = mpiLinksResponse.body as Patient;
        const links =
          patient.link?.map((link) =>
            createNewPatientRef(link.other.reference?.split('/').pop() || '')
          ) || [];

        const path: string = `/fhir/Patient?link=${encodeURIComponent(links.join(','))}`;
        const orchestration: Orchestration = createFhirDatastoreOrcherstation(
          'adding patient links',
          path
        );
        const fhirResponse = await getData(fhirProtocol, fhirHost, fhirPort, path, {});

        orchestration.response.status = fhirResponse.status;
        orchestration.response.body = JSON.stringify(fhirResponse.body);
        orchestration.response.timestamp = format(new Date(), "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
        orchestrations.push(orchestration);

        if (!isHttpStatusOk(fhirResponse.status)) {
          reject(fhirResponse);
        }

        const fhirBundle = fhirResponse.body as Bundle;

        if (bundle.entry && bundle.entry[index] && fhirBundle.entry) {
          const links = fhirBundle.entry.map((entry) => {
            return {
              type: 'refer',
              other: { reference: `Patient/${entry?.resource?.id || ''}` },
            };
          });
          resolve({
            fullUrl: fhirBundle.entry[index].fullUrl,
            resource: { ...bundle.entry[index].resource, link: links },
            request: fhirBundle.entry[index].request,
          });
        }
      } else {
        reject(mpiLinksResponse);
      }
    });

    promises.push(promise);
  });
};
