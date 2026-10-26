-- Run by the Jenkinsfile's Deploy stage, piped into psql inside the db
-- container (local socket, trust auth). Postgres only applies POSTGRES_PASSWORD
-- when the pgdata volume is first created; this makes the familytree role's
-- password follow the Jenkins credential on every deploy instead. Reading it
-- from the container's env keeps it off any command line or build log.
\getenv pw POSTGRES_PASSWORD
ALTER ROLE familytree PASSWORD :'pw';
