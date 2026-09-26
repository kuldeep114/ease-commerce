-- Runs once on first container start. Keeps `npm test`, which truncates tables between cases,
-- away from anything in the development database.
CREATE DATABASE courier_platform_test;
