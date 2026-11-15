/** JDBC driver libraries managed by Stratum and shared by the main process and the renderer. */

/** One JAR copied into <userData>/drivers by the Driver Manager. */
export interface DriverJar {
  /** Absolute path of the managed copy; this is what a JDBC data source stores. */
  path: string
  /** File name shown in the manager and suggested in the data-source dialog. */
  name: string
  /** File size in bytes. */
  size: number
  /** Last modification time, epoch milliseconds. */
  modifiedAt: number
}
