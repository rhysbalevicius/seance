output "instance_id" {
  value = aws_instance.box.id
}

output "private_ip" {
  description = "VPC-internal IP. You will never use it day to day; the box is reached via Tailscale."
  value       = aws_instance.box.private_ip
}

output "next_step" {
  value = "Watch bootstrap: the box appears in your tailnet as '${var.box_name}' within ~3 min; then `ssh ${var.dev_user}@${var.box_name}` (with the key you put in ssh_authorized_keys) and `tail -f /var/log/seance-bootstrap.log`."
}
