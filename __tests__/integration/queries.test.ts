import * as fs from "fs";
import * as path from "path";
import * as pg from "pg";
import * as adaptor from "postgraphile/@dataplan/pg/adaptors/pg";

import { promisify } from "util";
import {
  ExecutionArgs,
  GraphQLError,
  GraphQLSchema,
  parse,
  validate,
} from "graphql";
import { withPgClient, withPgPool } from "../helpers";
import { PgConditionArgumentPlugin } from "graphile-build-pg";
import { postgraphilePresetAmber } from "postgraphile/presets/amber";
import { makeV4Preset, V4Options } from "postgraphile/presets/v4";
import { makeSchema } from "postgraphile";
import { PostGraphileConnectionFilterPreset } from "../../src/index";
import CustomOperatorsPlugin from "./../customOperatorsPlugin";
import { execute, hookArgs, isSafeError } from "grafast";
import { SchemaResult } from "graphile-build";
import { makeWithPgClientViaPgClientAlreadyInTransaction } from "@dataplan/pg/adaptors/pg";
import { exportSchemaAsString } from "graphile-export";
import { importFromStringSync } from "module-from-string";

// TODO: remove this once Grafast gets it's planning under control :D
jest.setTimeout(300000);

const vmEval = (code: string) => {
  const { schema } = importFromStringSync(code, {
    transformOptions: { loader: "js" },
    useCurrentGlobal: true,
  });
  return schema as GraphQLSchema;
};

const createPostGraphileSchema = async (
  pool: pg.Pool,
  schemas: string[],
  v4Options: V4Options,
  anotherPreset: GraphileConfig.Preset = {}
) => {
  const preset: GraphileConfig.Preset = {
    extends: [
      postgraphilePresetAmber,
      PostGraphileConnectionFilterPreset,
      makeV4Preset(v4Options),
      ...(anotherPreset ? [anotherPreset] : []),
    ],
    pgServices: [
      {
        adaptor,
        name: "main",
        withPgClientKey: "withPgClient",
        pgSettingsKey: "pgSettings",
        schemas: schemas,
        adaptorSettings: {
          pool,
        },
      } as any, //GraphileConfig.PgDatabaseConfiguration<"@dataplan/pg/adaptors/pg">,
    ],
  };
  const params = await makeSchema(preset);
  if (process.env.TEST_EXPORTED_SCHEMA) {
    return {
      ...params,
      schema: vmEval(
        (
          await exportSchemaAsString(params.schema, {
            mode: "graphql-js",
            // or:
            // mode: "typeDefs",
            modules: {},
          })
        ).code
      ),
    };
  } else {
    return params;
  }
};

const readFile = promisify(fs.readFile);

const queriesDir = `${__dirname}/../fixtures/queries`;
const queryFileNames = fs.readdirSync(queriesDir);

let gqlSchemas: {
  normal: SchemaResult;
  dynamicJson: SchemaResult;
  networkScalars: SchemaResult;
  relations: SchemaResult;
  simpleCollections: SchemaResult;
  nullAndEmptyAllowed: SchemaResult;
  addConnectionFilterOperator: SchemaResult;
};

beforeAll(async () => {
  // Ensure process.env.TEST_DATABASE_URL is set
  if (!process.env.TEST_DATABASE_URL) {
    console.error(
      "ERROR: No test database configured; aborting. To resolve this, ensure environmental variable TEST_DATABASE_URL is set."
    );
    process.exit(1);
  }
  // Setup the DB schema and data
  await withPgClient(async (pgClient) => {
    await pgClient.query(
      await readFile(`${__dirname}/../p-schema.sql`, "utf8")
    );
    await pgClient.query(await readFile(`${__dirname}/../p-data.sql`, "utf8"));
  });
  // Get GraphQL schema instances that we can query.
  gqlSchemas = await withPgPool(async (pool) => {
    // Different fixtures need different schemas with different configurations.
    // Make all of the different schemas with different configurations that we
    // need and wait for them to be created in parallel.
    const [
      normal,
      dynamicJson,
      networkScalars,
      relations,
      simpleCollections,
      nullAndEmptyAllowed,
      addConnectionFilterOperator,
    ] = await Promise.all([
      createPostGraphileSchema(
        pool,
        ["p"],
        {
          skipPlugins: [PgConditionArgumentPlugin],
        },
        {}
      ),
      createPostGraphileSchema(
        pool,
        ["p"],
        {
          skipPlugins: [PgConditionArgumentPlugin],
          dynamicJson: true,
        },
        {}
      ),
      createPostGraphileSchema(
        pool,
        ["p"],
        {
          skipPlugins: [PgConditionArgumentPlugin],
          graphileBuildOptions: {
            pgUseCustomNetworkScalars: true,
          },
        },
        {}
      ),
      createPostGraphileSchema(
        pool,
        ["p"],
        {
          skipPlugins: [PgConditionArgumentPlugin],
          graphileBuildOptions: {
            connectionFilterRelations: true,
          },
        },
        {}
      ),
      createPostGraphileSchema(
        pool,
        ["p"],
        {
          skipPlugins: [PgConditionArgumentPlugin],
          simpleCollections: "only",
        },
        {}
      ),
      createPostGraphileSchema(
        pool,
        ["p"],
        {
          skipPlugins: [PgConditionArgumentPlugin],
          graphileBuildOptions: {
            connectionFilterAllowNullInput: true,
            connectionFilterAllowEmptyObjectInput: true,
          },
        },
        {}
      ),
      createPostGraphileSchema(
        pool,
        ["p"],
        {
          skipPlugins: [PgConditionArgumentPlugin],
        },
        {
          plugins: [CustomOperatorsPlugin],
        }
      ),
    ]);
    return {
      normal,
      dynamicJson,
      networkScalars,
      relations,
      simpleCollections,
      nullAndEmptyAllowed,
      addConnectionFilterOperator,
    };
  });
});

for (const queryFileName of queryFileNames) {
  // eslint-disable-next-line jest/valid-title
  test(queryFileName, async () => {
    // Read the query from the file system.
    const query = await readFile(
      path.resolve(queriesDir, queryFileName),
      "utf8"
    );
    // Get the appropriate GraphQL schema for this fixture. We want to test
    // some specific fixtures against a schema configured slightly
    // differently.
    const gqlSchemaByQueryFileName: {
      [queryFileName: string]: SchemaResult;
    } = {
      "addConnectionFilterOperator.graphql":
        gqlSchemas.addConnectionFilterOperator,
      "dynamicJsonTrue.graphql": gqlSchemas.dynamicJson,
      "types.cidr.graphql": gqlSchemas.networkScalars,
      "types.macaddr.graphql": gqlSchemas.networkScalars,
      "arrayTypes.cidrArray.graphql": gqlSchemas.networkScalars,
      "arrayTypes.macaddrArray.graphql": gqlSchemas.networkScalars,
      "relations.graphql": gqlSchemas.relations,
      "simpleCollections.graphql": gqlSchemas.simpleCollections,
      "nullAndEmptyAllowed.graphql": gqlSchemas.nullAndEmptyAllowed,
    };
    const { schema, resolvedPreset } =
      queryFileName in gqlSchemaByQueryFileName
        ? gqlSchemaByQueryFileName[queryFileName]
        : gqlSchemas.normal;
    const document = parse(query);
    const errors = validate(schema, document);
    if (errors.length > 0) {
      throw new Error(
        `GraphQL validation errors:\n${errors.map((e) => e.message).join("\n")}`
      );
    }
    const args: ExecutionArgs = {
      schema,
      document,
    };
    await hookArgs(args, resolvedPreset, {});
    //const pgSubscriber = new PgSubscriber(pool);
    const result = (await withPgClient(async (pgClient) => {
      // We must override the context because we didn't use a pool above and so
      // we need to add our own client

      // NOTE: the withPgClient needed on context is **VERY DIFFERENT** to our
      // withPgClient test helper. We should rename our test helper ;)
      const contextWithPgClient =
        makeWithPgClientViaPgClientAlreadyInTransaction(pgClient, false);
      try {
        args.contextValue = {
          pgSettings: (args.contextValue as any).pgSettings,
          withPgClient: contextWithPgClient,
          //pgSubscriber,
        };

        return (await execute(args)) as any;
      } finally {
        contextWithPgClient.release?.();
      }
    })) as any;
    expect(result).toMatchSnapshot();
  });
}
