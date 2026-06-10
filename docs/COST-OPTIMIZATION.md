# Cost Optimization Guide - TesboGrid

## 💰 Scheduled Scaling for Development Phase

**Working Hours**: Monday-Friday, 11:00 AM - 8:00 PM IST  
**Off Hours**: Weekday evenings + Full weekends

### Current Cost Analysis

| Resource | Always-On Cost/mo | Scheduled Cost/mo | Savings |
|----------|-------------------|-------------------|---------|
| 7 Kubernetes Nodes (s-4vcpu-8gb) | $672 | $672* | $0 |
| 25 Selenium Chrome Pods | Included | Included | CPU/Memory freed |
| PostgreSQL (db-amd-1vcpu-1gb) | $36 | $36 | $0 |
| Redis (db-s-1vcpu-1gb) | $15 | $15 | $0 |
| **Node Pool with Autoscaling** | | | |
| - Min 2 nodes (off-hours) | - | $192/mo | -$480/mo |
| - Max 7 nodes (work hours) | - | Only when needed | **70% savings** |

\* With autoscaling: nodes scale down to minimum when pods are removed

### 💡 Recommended Setup

#### Option 1: CronJob-based Scaling (Zero infrastructure)
- ✅ No external dependencies
- ✅ Runs inside Kubernetes
- ✅ Automatic execution
- ✅ Built-in retry logic

**Deploy:**
```bash
kubectl apply -f infra/kubernetes/scheduled-scaling-cronjobs.yaml
```

**Schedule:**
- **Scale UP**: Mon-Fri at 11:00 AM IST (05:30 UTC)
- **Scale DOWN**: Mon-Fri at 8:00 PM IST (14:30 UTC)
- **Weekend shutdown**: Sat-Sun all day

#### Option 2: Node Pool Autoscaling (Maximum savings)
Configure DigitalOcean node pool to scale based on resource usage:

```bash
doctl kubernetes cluster node-pool update tesbox-execute-kubernets \
  tesbox-exec-4cpu \
  --auto-scale=true \
  --min-nodes=2 \
  --max-nodes=7
```

**Combined with CronJob scaling**:
- Work hours: Pods scale up → Nodes auto-scale to 7
- Off hours: Pods scale to 0 → Nodes auto-scale to 2
- **Estimated savings: $480/month (70%)**

### Manual Override

When you need to work outside scheduled hours:

```bash
# Scale UP immediately
./scripts/manual-scale.sh up

# Scale DOWN immediately
./scripts/manual-scale.sh down

# Check current status
kubectl get pods -n tesbo-execution
```

### Verification

Check CronJob schedules:
```bash
kubectl get cronjobs -n tesbo-execution

# View last execution
kubectl get jobs -n tesbo-execution

# View logs
kubectl logs -n tesbo-execution job/scale-up-workday-<job-id>
```

### Important Notes

1. **Workers auto-scale to zero** via KEDA (already configured) ✅
2. **Selenium nodes** consume most resources - these need scheduled scaling
3. **Node pool autoscaling** = biggest cost savings
4. **Database & Redis** stay on 24/7 (minimal cost, needed for data persistence)

### Pre-Launch Migration

When ready to launch:

```bash
# Remove scheduled scaling
kubectl delete cronjob scale-up-workday scale-down-workday scale-down-weekend -n tesbo-execution

# Update node pool for production
doctl kubernetes cluster node-pool update tesbox-execute-kubernets \
  tesbox-exec-4cpu \
  --auto-scale=true \
  --min-nodes=5 \
  --max-nodes=15

# Update Selenium node minimums
kubectl patch scaledobject selenium-node-chrome-scaler -n tesbo-execution \
  --type=json -p='[{"op": "replace", "path": "/spec/minReplicaCount", "value": 10}]'
```

### Monitoring Cost Impact

```bash
# Check node count throughout the day
doctl kubernetes cluster node-pool get tesbox-execute-kubernets tesbox-exec-4cpu

# View autoscaling activity
kubectl get events -n tesbo-execution --sort-by='.lastTimestamp' | grep -i scale
```

## 🎯 Summary

| Phase | Configuration | Monthly Cost |
|-------|---------------|--------------|
| **Current** | 7 nodes always-on | ~$740 |
| **Development** | 2-7 nodes (scheduled) | ~$260 |
| **Production** | 5-15 nodes (on-demand) | ~$480-1080 |

**Development phase savings: ~$480/month (65%)**
