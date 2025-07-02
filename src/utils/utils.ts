import format from 'date-fns/format';
import fetch, { HeaderInit, HeadersInit } from 'node-fetch';

import { getConfig } from '../config/config';
import logger from '../logger';
import {
  OpenHimResponseObject,
  ResponseObject,
  Response,
  MpiMediatorResponseObject,
  MpiTransformResult,
  Orchestration,
} from '../types/response';
import { RequestDetails } from '../types/request';
import { Bundle, BundleEntry, BundleLink, FhirResource, Patient } from 'fhir/r3';
import { PatientData } from '../types/newPatientMap';

const config = getConfig();
const {
  fhirDatastoreProtocol: fhirProtocol,
  fhirDatastoreHost: fhirHost,
  fhirDatastorePort: fhirPort,
  mpiProtocol,
  mpiHost,
  mpiPort
} = config;

const headers: HeadersInit = {
  'Content-Type': 'application/fhir+json',
};

export const isHttpStatusOk = (status: number) => status >= 200 && status < 300;

export const sendRequest = async ({
  protocol,
  host,
  port,
  path,
  headers,
  data,
  method,
}: RequestDetails): Promise<ResponseObject> => {
  let body: object = {};
  let status = 200;

  try {
    const response = await fetch(`${protocol}://${host}:${port}${path}`, {
      headers,
      body: data,
      method: method,
    });

    body = await response.json();
    status = response.status;
  } catch (err) {
    if (typeof err === 'string') {
      body = { error: err };
    } else if (err instanceof Error) {
      body = { error: err.message };
    }

    status = 500;
  }

  return {
    status,
    body,
  };
};

export const getData = async (
  protocol: string,
  host: string,
  port: number | string,
  path: string,
  headers: HeadersInit
): Promise<ResponseObject> => {
  return sendRequest({
    method: 'GET',
    protocol,
    host,
    port,
    headers,
    path,
  });
};

export const postData = async (
  protocol: string,
  host: string,
  port: number | string,
  path: string,
  data: string,
  headers: HeaderInit = { 'Content-Type': 'application/fhir+json' }
): Promise<ResponseObject> => {
  return sendRequest({
    method: 'POST',
    protocol,
    host,
    port,
    path,
    headers,
    data,
  });
};

export const buildOpenhimResponseObject = (
  openhimTransactionStatus: string,
  httpResponseStatusCode: number,
  responseBody: object,
  contentType = 'application/fhir+json',
  orchestrations: Orchestration[] = []
): OpenHimResponseObject => {
  const response: Response = {
    status: httpResponseStatusCode,
    headers: { 'Content-Type': contentType },
    body: JSON.stringify(responseBody),
    timestamp: format(new Date(), "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"),
  };

  return {
    'x-mediator-urn': config.mediatorUrn,
    status: openhimTransactionStatus,
    response,
    orchestrations,
  };
};

export const extractPatientEntries = (bundle: Bundle): BundleEntry<Patient>[] => {
  if (!bundle || !bundle.entry || !bundle.entry.length) {
    return [];
  }

  const patientEntries = bundle.entry.filter(
    (val) => val.resource?.resourceType === 'Patient'
  );

  return patientEntries as BundleEntry<Patient>[];
};

/*
  This function modifies the bundle by gutting all patient resources and leaving a link to the
  newly created client registry Patient resource.
  It also adds the request property to the bundle entries for bundles of type 'document'.
*/
export const modifyBundle = (
  bundle: Bundle,
  newPatientIdMap: {
    [key: string]: {
      mpiTransformResult?: MpiTransformResult;
      mpiResponsePatient?: Patient;
    };
  } = {},
  patientProfileForStubPatient?: string
): Bundle => {
  const modifiedBundle = Object.assign({}, bundle);

  if (modifiedBundle.type === 'document') {
    logger.info('Converting document bundle to transaction bundle');
    modifiedBundle.type = 'transaction';
  }

  const newEntry = modifiedBundle.entry?.map((entry) => {
    if (
      entry.resource?.resourceType === 'Patient' &&
      entry.fullUrl &&
      newPatientIdMap[entry.fullUrl]
    ) {
      // strip out patient details and replace with reference to new patient in MPI
      const newPatientId = newPatientIdMap[entry.fullUrl].mpiResponsePatient?.id;

      if (!newPatientId) {
        logger.error('ID in MPI response is missing');
        throw new Error('ID in MPI response is missing');
      }

      const stubPatient: BundleEntry<Patient> = {
        fullUrl: entry.fullUrl,
        resource: {
          resourceType: 'Patient',
          id: entry.resource.id,
          link: [
            {
              other: {
                reference: createNewPatientRef(newPatientId),
              },
              type: 'refer',
            },
          ],
        },
        request: {
          method: 'PUT',
          url: `Patient/${entry.resource.id}`,
        },
      };

      if (patientProfileForStubPatient && stubPatient.resource) {
        stubPatient.resource.meta = {
          profile: [patientProfileForStubPatient],
        };
      }

      return stubPatient;
    }

    // Add request property to the bundle entries if missing, default to using upserts
    if (!entry.request) {
      return Object.assign({}, entry, {
        request: {
          method: 'PUT',
          url: `${entry.resource?.resourceType}/${entry.resource?.id}`,
        },
      });
    }

    return entry;
  });

  modifiedBundle.entry = newEntry as BundleEntry<FhirResource>[];

  return modifiedBundle;
};

/**
 * This method removes the patient's extension and managing organization. The Client registry only stores Patient resources. Extensions and Managing Organization
 * references will result in validation errors.
 * The function returns a tranformed patient, extension and managing organization.
 */
export const transformPatientResourceForMPI = (patient: Patient): MpiTransformResult => {
  const transformedPatient = JSON.parse(JSON.stringify(patient));

  const extension = transformedPatient.extension;
  const managingOrganization = transformedPatient.managingOrganization;

  //delete transformedPatient.extension;
  //delete transformedPatient.managingOrganization;

  return {
    patient: transformedPatient,
    managingOrganization,
    extension,
  };
};

/**
 * This method restores the patient's original managing organization and extensions
 */
export const restorePatientResource = (patientData: PatientData) => {
  patientData.restoredPatient = patientData.mpiResponsePatient;

  // restore the source uuid of the patient
  const id = Object.assign({ id: '' }, patientData.mpiTransformResult?.patient).id;
  patientData.restoredPatient = Object.assign({}, patientData.restoredPatient, { id });

  if (patientData.mpiTransformResult?.extension?.length) {
    patientData.restoredPatient = Object.assign({}, patientData.restoredPatient, {
      extension: patientData.mpiTransformResult.extension,
    });
  }

  if (patientData.mpiTransformResult?.managingOrganization) {
    patientData.restoredPatient = Object.assign({}, patientData.restoredPatient, {
      managingOrganization: patientData.mpiTransformResult.managingOrganization,
    });
  }
};

export const createNewPatientRef = (patientId: string): string => {
  if (config.mpiProxyUrl) {
    return `${config.mpiProxyUrl}/fhir/Patient/${patientId}`;
  }

  return `${config.mpiProtocol}://${config.mpiHost}:${config.mpiPort}/fhir/Patient/${patientId}`;
};

export const createHandlerResponseObject = (
  transactionStatus: string,
  response: ResponseObject,
  orchestrations?: Orchestration[]
): MpiMediatorResponseObject => {
  const responseBody = buildOpenhimResponseObject(
    transactionStatus,
    response.status,
    response.body,
    'application/fhir+json',
    orchestrations
  );

  return {
    body: responseBody,
    status: response.status,
  };
};

export const mergeBundles = async (
  fhirRequests: (Bundle<FhirResource> | null)[],
  type = 'searchset'
) => {
  const fhirBundles = fhirRequests.filter((bundle) => !!bundle) as Bundle[];
  // Combine all bundles into a single one
  const bundle = fhirBundles.reduce(
    (acc, curr) => {
      // Concat entries
      if (Array.isArray(curr.entry)) {
        acc.entry = (acc.entry || []).concat(curr.entry);
        acc.total = (acc.total || 0) + curr.entry.length;
      }

      // Concat links
      if (curr.link && Array.isArray(curr.link)) {
        acc.link = (acc.link || []).concat(
          curr.link.map(({ url }) => {
            return {
              relation: 'subsection',
              url,
            } as BundleLink;
          })
        );
      }

      return acc;
    },
    {
      resourceType: 'Bundle',
      meta: {
        lastUpdated: format(new Date(), "yyyy-MM-dd'T'HH:mm"),
      },
      type,
      total: 0,
      link: [],
      entry: [],
    } as Bundle
  );

  return bundle;
};

export const patientProjector = (patient: Patient): Patient => {
  return {
    resourceType: patient.resourceType,
    id: patient.id,
    identifier: patient.identifier,
    name: patient.name,
    birthDate: patient.birthDate,
    gender: patient.gender
  };
};

export const createFhirDatastoreOrcherstation = (name: string, path: string): Orchestration => ({
  name: `Request to fhir datastore - ${path} : ${name}`,
  request: {
    protocol: fhirProtocol,
    host: fhirHost,
    path,
    port: fhirPort,
    method: 'GET',
    headers,
    timestamp: format(new Date(), "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"),
  },
  response: {
    status: 200,
    body: '',
    timestamp: '',
  },
});

export const createClientRegistryOrcherstation = (name: string, path: string): Orchestration => ({
  name: `Request to client registry - ${path} : ${name}`,
  request: {
    protocol: mpiProtocol,
    host: mpiHost,
    path,
    port: mpiPort,
    method: 'GET',
    headers,
    timestamp: format(new Date(), "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"),
  },
  response: {
    status: 200,
    body: '',
    timestamp: '',
  },
});
