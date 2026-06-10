terraform {
  required_version = ">= 1.5"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {
  token = var.do_token
}

# --- Container Registry ---

resource "digitalocean_container_registry" "execution" {
  name                   = var.registry_name
  subscription_tier_slug = "basic"
  region                 = var.region
}

# --- Managed PostgreSQL ---

resource "digitalocean_database_cluster" "execution_db" {
  name       = "${var.project_name}-db"
  engine     = "pg"
  version    = "16"
  size       = var.db_size
  region     = var.region
  node_count = 1

  maintenance_window {
    day  = "sunday"
    hour = "04:00:00"
  }
}

resource "digitalocean_database_db" "execution" {
  cluster_id = digitalocean_database_cluster.execution_db.id
  name       = "tesbo_execution"
}

# --- Managed Redis ---

resource "digitalocean_database_cluster" "execution_redis" {
  name       = "${var.project_name}-redis"
  engine     = "redis"
  version    = "7"
  size       = var.redis_size
  region     = var.region
  node_count = 1
}

# --- Droplet for API + Workers (simple deployment) ---

resource "digitalocean_droplet" "execution_host" {
  name     = "${var.project_name}-host"
  image    = "docker-20-04"
  size     = var.droplet_size
  region   = var.region
  ssh_keys = var.ssh_key_ids

  user_data = <<-EOF
    #!/bin/bash
    apt-get update && apt-get install -y docker-compose-plugin
    mkdir -p /opt/tesbo-execution/artifacts
    echo "Tesbo Execution host provisioned"
  EOF
}
