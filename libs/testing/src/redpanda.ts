import { RedpandaContainer, type StartedRedpandaContainer } from '@testcontainers/redpanda';

export interface TestBroker {
  brokers: string[];
  schemaRegistryUrl: string;
  /** Stops the broker container. */
  stop(): Promise<void>;
  container: StartedRedpandaContainer;
}

/** A throwaway single-node Redpanda broker with schema registry. Needs Docker. */
export async function startTestBroker(): Promise<TestBroker> {
  const container = await new RedpandaContainer(
    'docker.redpanda.com/redpandadata/redpanda:v24.2.7',
  ).start();
  return {
    container,
    brokers: [container.getBootstrapServers()],
    schemaRegistryUrl: container.getSchemaRegistryAddress(),
    stop: async () => {
      await container.stop();
    },
  };
}
