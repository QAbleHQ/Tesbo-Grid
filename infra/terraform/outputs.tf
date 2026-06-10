output "database_uri" {
  description = "PostgreSQL connection URI"
  value       = digitalocean_database_cluster.execution_db.uri
  sensitive   = true
}

output "redis_uri" {
  description = "Redis connection URI"
  value       = digitalocean_database_cluster.execution_redis.uri
  sensitive   = true
}

output "droplet_ip" {
  description = "Execution host public IP"
  value       = digitalocean_droplet.execution_host.ipv4_address
}

output "registry_endpoint" {
  description = "Container registry endpoint"
  value       = digitalocean_container_registry.execution.endpoint
}
