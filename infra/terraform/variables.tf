variable "do_token" {
  description = "DigitalOcean API token"
  type        = string
  sensitive   = true
}

variable "region" {
  description = "DigitalOcean region"
  type        = string
  default     = "nyc3"
}

variable "project_name" {
  description = "Project name prefix for resources"
  type        = string
  default     = "tesbo-execution"
}

variable "registry_name" {
  description = "Container registry name"
  type        = string
  default     = "tesbo-execution"
}

variable "db_size" {
  description = "Database droplet size"
  type        = string
  default     = "db-s-1vcpu-1gb"
}

variable "redis_size" {
  description = "Redis droplet size"
  type        = string
  default     = "db-s-1vcpu-1gb"
}

variable "droplet_size" {
  description = "Application droplet size"
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "ssh_key_ids" {
  description = "SSH key IDs for droplet access"
  type        = list(string)
  default     = []
}
