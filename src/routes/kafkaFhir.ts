import { Kafka, logLevel } from "kafkajs";

import { Bundle, Entry, Resource } from "../types/bundle";
import { getConfig } from "../config/config";
import { RequestDetails } from "../types/request";
import {
  AuthHeader,
  HandlerResponseObect,
  ResponseObject,
} from "../types/response";
import {
  createAuthHeaderToken,
  createHandlerResponseObject,
  createNewPatientRef,
  extractPatientId,
  extractPatientResource,
  modifyBundle,
  sendRequest,
} from "./utils";
import logger from "../logger";

const config = getConfig();

const kafka = new Kafka({
  logLevel: logLevel.ERROR,
  clientId: config.mpiKafkaClientId,
  brokers: config.kafkaBrokers.split(","),
});
const producer = kafka.producer();

export const sendToKafka = async (
  bundle: Bundle,
  topic: string
): Promise<Error | null> => {
  try {
    await producer.connect();
    await producer.send({
      topic,
      messages: [
        {
          value: JSON.stringify(bundle),
        },
      ],
    });
  } catch (error) {
    if (typeof error === "string") {
      return new Error(error);
    } else if (error instanceof Error) {
      return error;
    }
  }
  return null;
};

export const sendToFhirAndKafka = async (
  requestDetails: RequestDetails,
  bundle: Bundle,
  patient: object | null = null,
  newPatientRef: string = ""
): Promise<HandlerResponseObect> => {
  requestDetails.data = JSON.stringify(bundle);

  const response: ResponseObject = await sendRequest(requestDetails);

  let transactionStatus: string;

  if (response.status === 200) {
    logger.info("Successfully sent Fhir bundle to the Fhir Datastore!");

    transactionStatus = "Success";

    if (patient) {
      const patientEntry: Entry = {
        fullUrl: newPatientRef,
        resource: Object.assign(
          {
            id: "",
            resourceType: "",
          },
          patient
        ),
        request: {
          method: "PUT",
          url: newPatientRef,
        },
      };
      bundle.entry.push(patientEntry);
      const entry: Entry[] = [];
      const newBundle = Object.assign({ entry: entry }, response.body);
      newBundle.entry.push(patientEntry);
      response.body = newBundle;
    }

    const kafkaResponseError: Error | null = await sendToKafka(
      bundle,
      config.kafkaBundleTopic
    );

    if (kafkaResponseError) {
      logger.error(
        `Sending Fhir bundle to Kafka failed: ${JSON.stringify(
          kafkaResponseError
        )}`
      );

      transactionStatus = "Failed";
      response.body = { kafkaResponseError };
      response.status = 500;
    } else {
      logger.info("Successfully sent Fhir bundle to Kafka");
    }
  } else {
    logger.error(
      `Error in sending Fhir bundle to Fhir Datastore: ${JSON.stringify(
        response.body
      )}!`
    );
    transactionStatus = "Failed";
  }

  return createHandlerResponseObject(transactionStatus, response);
};

const clientRegistryRequestDetailsOrg: RequestDetails = {
  protocol: config.clientRegistryProtocol,
  host: config.clientRegistryHost,
  port: config.clientRegistryPort,
  path: '/fhir/Patient',
  method: 'POST',
  contentType: 'application/fhir+json',
  authToken: ''
};
const fhirDatastoreRequestDetailsOrg: RequestDetails = {
  protocol: config.fhirDatastoreProtocol,
  host: config.fhirDatastoreHost,
  port: config.fhirDatastorePort,
  contentType: 'application/fhir+json',
  method: 'POST',
  path: '/fhir',
  data: ''
};

export const processBundle = async (bundle: Bundle): Promise<HandlerResponseObect> => {
  const fhirDatastoreRequestDetails: RequestDetails = Object.assign({}, fhirDatastoreRequestDetailsOrg);
  const clientRegistryRequestDetails: RequestDetails = Object.assign({}, clientRegistryRequestDetailsOrg);
  const patientResource: Resource | null = extractPatientResource(bundle);
  const patientId: string | null = extractPatientId(bundle);

  if (!(patientResource || patientId)) {
    logger.info('No Patient resource or Patient reference was found in Fhir Bundle!');

    const handlerResponse: HandlerResponseObect = await sendToFhirAndKafka(fhirDatastoreRequestDetails, modifyBundle(bundle));
    return handlerResponse;
  }

  const auth: AuthHeader = await createAuthHeaderToken();
  clientRegistryRequestDetails.authToken = auth.token;

  if (!patientResource && patientId) {
    clientRegistryRequestDetails.path = `/fhir/Patient/${patientId}`;
    clientRegistryRequestDetails.method = 'GET';
    delete clientRegistryRequestDetails.data;
  } else {
    clientRegistryRequestDetails.data = JSON.stringify(patientResource)
  }

  const clientRegistryResponse: ResponseObject = await sendRequest(clientRegistryRequestDetails);

  if (!(clientRegistryResponse.status === 201 || clientRegistryResponse.status === 200)) {
    if (patientResource) {
      logger.error(`Patient resource creation in Client Registry failed: ${JSON.stringify(clientRegistryResponse.body)}`);
    } else {
      logger.error(`Checking of patient with id ${patientId} failed in Client Registry: ${JSON.stringify(clientRegistryResponse.body)}`);
    }
    return createHandlerResponseObject('Failed', clientRegistryResponse);
  }

  const newPatientRef: string = createNewPatientRef(clientRegistryResponse.body);
  const modifiedBundle: Bundle = modifyBundle(bundle, `Patient/${patientId}`, newPatientRef);

  const handlerResponse: HandlerResponseObect = await sendToFhirAndKafka(
    fhirDatastoreRequestDetails, modifiedBundle, clientRegistryResponse.body, newPatientRef
  );

  return handlerResponse;
};